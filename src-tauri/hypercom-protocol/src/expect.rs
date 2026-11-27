//! Streaming byte and line expectation matcher for `Request` operations.

use crate::protocol::{ExpectSpec, HostError, MAX_EXPECT_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpectPattern {
    Literal(Vec<u8>),
    Line(Vec<u8>),
}

impl ExpectPattern {
    pub fn new_literal(bytes: Vec<u8>) -> Result<Self, HostError> {
        validate_len(&bytes)?;
        Ok(Self::Literal(bytes))
    }

    pub fn new_line(bytes: Vec<u8>) -> Result<Self, HostError> {
        if bytes.contains(&b'\n') {
            return Err(HostError::new(
                "invalid_request",
                "line expectation cannot contain LF",
            ));
        }
        validate_len(&bytes)?;
        Ok(Self::Line(bytes))
    }

    pub fn from_spec(spec: &ExpectSpec) -> Result<Self, HostError> {
        match spec {
            ExpectSpec::Line { text } => Self::new_line(text.as_bytes().to_vec()),
            ExpectSpec::Text { text } => Self::new_literal(text.as_bytes().to_vec()),
            ExpectSpec::Bytes { data_base64 } => {
                let bytes = STANDARD.decode(data_base64).map_err(|_| {
                    HostError::new("invalid_request", "expect dataBase64 is not valid base64")
                })?;
                Self::new_literal(bytes)
            }
        }
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::Literal(bytes) | Self::Line(bytes) => bytes,
        }
    }
}

fn validate_len(bytes: &[u8]) -> Result<(), HostError> {
    if bytes.is_empty() || bytes.len() > MAX_EXPECT_BYTES {
        return Err(HostError::new(
            "invalid_request",
            format!("expectation must contain 1–{MAX_EXPECT_BYTES} bytes"),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub enum ExpectMatcher {
    Literal {
        bytes: Vec<u8>,
        prefix: Vec<usize>,
        position: usize,
        matched: bool,
    },
    Line {
        bytes: Vec<u8>,
        position: usize,
        mismatch: bool,
        matched: bool,
    },
}

impl ExpectMatcher {
    pub fn new(pattern: ExpectPattern, at_line_start: bool) -> Self {
        match pattern {
            ExpectPattern::Literal(bytes) => {
                let mut prefix = vec![0; bytes.len()];
                for index in 1..bytes.len() {
                    let mut previous = prefix[index - 1];
                    while previous > 0 && bytes[index] != bytes[previous] {
                        previous = prefix[previous - 1];
                    }
                    prefix[index] = previous + usize::from(bytes[index] == bytes[previous]);
                }
                Self::Literal {
                    bytes,
                    prefix,
                    position: 0,
                    matched: false,
                }
            }
            ExpectPattern::Line(bytes) => Self::Line {
                bytes,
                position: 0,
                mismatch: !at_line_start,
                matched: false,
            },
        }
    }

    pub fn from_spec(spec: &ExpectSpec, at_line_start: bool) -> Result<Self, HostError> {
        Ok(Self::new(ExpectPattern::from_spec(spec)?, at_line_start))
    }

    pub fn feed(&mut self, span: &[u8]) {
        match self {
            Self::Literal {
                bytes,
                prefix,
                position,
                matched,
            } if !*matched => {
                for byte in span {
                    while *position > 0 && bytes[*position] != *byte {
                        *position = prefix[*position - 1];
                    }
                    if bytes[*position] == *byte {
                        *position += 1;
                    }
                    if *position == bytes.len() {
                        *matched = true;
                        break;
                    }
                }
            }
            Self::Line {
                bytes,
                position,
                mismatch,
                matched,
            } if !*matched => {
                for byte in span {
                    if *byte == b'\n' {
                        if !*mismatch && *position >= bytes.len() {
                            *matched = true;
                            break;
                        }
                        *mismatch = false;
                        *position = 0;
                    } else if !*mismatch {
                        let expected = bytes
                            .get(*position)
                            .copied()
                            .or_else(|| (*position == bytes.len()).then_some(b'\r'));
                        *mismatch = expected != Some(*byte);
                        *position += 1;
                    }
                }
            }
            _ => {}
        }
    }

    pub fn matched(&self) -> Option<&[u8]> {
        match self {
            Self::Literal {
                bytes,
                matched: true,
                ..
            }
            | Self::Line {
                bytes,
                matched: true,
                ..
            } => Some(bytes),
            _ => None,
        }
    }

    pub fn is_matched(&self) -> bool {
        self.matched().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::{ExpectMatcher, ExpectPattern};
    use crate::protocol::ExpectSpec;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn text_and_bytes_match_across_chunk_boundaries() {
        let mut matcher = ExpectMatcher::from_spec(
            &ExpectSpec::Text {
                text: "ababac".into(),
            },
            true,
        )
        .unwrap();
        matcher.feed(b"xabab");
        matcher.feed(b"ab");
        assert!(!matcher.is_matched());
        matcher.feed(b"acbye");
        assert_eq!(matcher.matched(), Some(b"ababac".as_slice()));

        let raw = [0xDEu8, 0xAD, 0xBE, 0xEF];
        let mut bytes_matcher = ExpectMatcher::from_spec(
            &ExpectSpec::Bytes {
                data_base64: STANDARD.encode(raw),
            },
            false,
        )
        .unwrap();
        bytes_matcher.feed(&[0x00, 0xDE, 0xAD]);
        assert!(!bytes_matcher.is_matched());
        bytes_matcher.feed(&[0xBE]);
        assert!(!bytes_matcher.is_matched());
        bytes_matcher.feed(&[0xEF, 0x99]);
        assert_eq!(bytes_matcher.matched(), Some(raw.as_slice()));
    }

    #[test]
    fn line_matcher_excludes_partial_and_substrings_and_spans_chunks() {
        let mut matcher = ExpectMatcher::from_spec(
            &ExpectSpec::Line {
                text: "answer".into(),
            },
            false,
        )
        .unwrap();
        matcher.feed(b"answer\nNOanswer\nanswer?\nans");
        assert!(!matcher.is_matched());
        matcher.feed(b"wer\r");
        assert!(!matcher.is_matched());
        matcher.feed(b"\n");
        assert_eq!(matcher.matched(), Some(b"answer".as_slice()));

        let mut lf_only = ExpectMatcher::from_spec(
            &ExpectSpec::Line { text: "OK".into() },
            true,
        )
        .unwrap();
        lf_only.feed(b"OK\n");
        assert_eq!(lf_only.matched(), Some(b"OK".as_slice()));
    }

    #[test]
    fn rejects_invalid_patterns() {
        assert!(ExpectPattern::from_spec(&ExpectSpec::Line {
            text: "a\nb".into(),
        })
        .is_err());
        assert!(ExpectPattern::from_spec(&ExpectSpec::Text {
            text: "".into(),
        })
        .is_err());
        assert!(ExpectPattern::from_spec(&ExpectSpec::Bytes {
            data_base64: "not-valid-base64!!!".into(),
        })
        .is_err());
    }
}
