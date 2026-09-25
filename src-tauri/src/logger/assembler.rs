/**
 * 日志侧 RX 行聚合器（LogLineAssembler）。
 *
 * 串口读事件按 ≤1024B/次切分、与行边界无关：一次设备响应可能横跨多个
 * serial:data 事件，一个事件里也可能有多行。本聚合器按 0x0A (LF) / 0x0D (CR)
 * 在**字节级**把流切成「已完成行的字节块」。终端侧有一份等价实现
 * （src/utils/rxAssembler.ts 的 RxLineAssembler）——两侧语义必须一致：本文件
 * `tests` 钉住 Rust 侧（含强制发射后不得产出幻影空行），前端侧对应
 * src/utils/rxAssembler.test.ts。
 *
 * 规则：
 * - CR、LF 均为分隔符；跨两次 feed 的 CRLF 对识别为**一个**分隔符——CR 处发射
 *   当前行并置 `pending_cr` 标记，下一字节是 LF 则静默吞掉，是其它字节则照常
 *   处理（标记随之清除）。
 * - 单独的 CR 也是分隔符（classic Mac 风格 / 部分设备）。
 * - 连续分隔符发射空块（空行）。
 * - `pending` 达到 `max_pending_bytes` 时无分隔符强制发射——防止无换行的二进制流
 *   让缓冲无限增长。强制发射后**紧跟**的分隔符只终结那个已发射的行，不再发射
 *   空块（`just_forced`）——否则流经过一次强制发射就会凭空多出一个幻影空行。
 *
 * 0x0A/0x0D 不可能出现在 UTF-8 / GBK 的多字节序列内部（ISO-8859-1 与 ASCII
 * 本就是单字节），因此字节级切分对全部四种受支持编码都安全。
 *
 * 纯逻辑：无 IO 依赖，可独立单测（FFI-free，Windows cargo test 可跑）。
 */

/// 无分隔符强制发射阈值（与前端 RxLineAssembler 默认一致）
const RX_LINE_MAX_PENDING_BYTES: usize = 4096;

pub(super) struct LogLineAssembler {
    /// 尚未终结的行字节（不含分隔符）
    pending: Vec<u8>,
    /// 上一个发射的分隔符是 CR：下一字节若是 LF 则视为 CRLF 对的后半，静默吞掉
    pending_cr: bool,
    /// 刚做过强制发射（`pending` 达到 `max_pending_bytes`）：紧跟的分隔符属于
    /// 「已发射的行」，不再发射空块。任意后续普通字节后清除。
    just_forced: bool,
    /// 强制发射阈值（字节）：`pending` 达到该长度即无分隔符发射。默认 4096
    max_pending_bytes: usize,
}

impl LogLineAssembler {
    pub(super) fn new() -> Self {
        Self::with_max_pending(RX_LINE_MAX_PENDING_BYTES)
    }

    /// 自定义强制发射阈值（测试注入用）
    pub(super) fn with_max_pending(max_pending_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            pending_cr: false,
            just_forced: false,
            max_pending_bytes,
        }
    }

    /// 喂入一段字节，返回按流顺序完成的行字节块（块内容不含分隔符）。
    /// 输入不会被修改；返回块是独立分配。
    pub(super) fn feed(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut lines: Vec<Vec<u8>> = Vec::new();
        for &b in bytes {
            if self.pending_cr {
                self.pending_cr = false;
                if b == b'\n' {
                    // CRLF 对的后半：行已在 CR 处发射，静默消费
                    continue;
                }
                // 非 LF：标记已清除，按普通字节继续处理
            }
            if b == b'\r' || b == b'\n' {
                if self.just_forced && self.pending.is_empty() {
                    // 强制发射后紧跟的分隔符：内容已在强制发射时成为一行，此分隔符
                    // 只终结那个已发射的行。CR 仍置 pending_cr 以吞掉配对的 LF，
                    // 让整个 CRLF 都归属于已发射行。
                    self.just_forced = false;
                    if b == b'\r' {
                        self.pending_cr = true;
                    }
                    continue;
                }
                // 分隔符：发射当前行（pending 为空时即空块 = 空行），重置 pending。
                // CR 额外置 pending_cr，用于识别跨 feed 的 CRLF 对。
                lines.push(std::mem::take(&mut self.pending));
                self.just_forced = false;
                if b == b'\r' {
                    self.pending_cr = true;
                }
            } else {
                self.pending.push(b);
                self.just_forced = false;
                if self.pending.len() >= self.max_pending_bytes {
                    // 强制发射：防止无换行二进制流无界增长。发射后继续扫描本段剩余字节
                    lines.push(std::mem::take(&mut self.pending));
                    self.just_forced = true;
                }
            }
        }
        lines
    }

    /// 取出未终结的尾部字节并重置状态（静默冲刷 / 关闭时用）。
    /// 无 pending 字节时返回 None。
    pub(super) fn take_tail(&mut self) -> Option<Vec<u8>> {
        self.pending_cr = false;
        self.just_forced = false;
        let tail = std::mem::take(&mut self.pending);
        if tail.is_empty() {
            None
        } else {
            Some(tail)
        }
    }

    /// 是否存在未终结的尾部字节
    pub(super) fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

/// 与前端 `src/utils/rxAssembler.test.ts` 同一组向量：任一侧改了语义，另一侧的
/// 对应用例必然变红。
#[cfg(test)]
mod tests {
    use super::LogLineAssembler;

    fn bytes(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    /// 显式类型的空行字节块（`vec![]` 嵌套推断在 PartialEq 上会有歧义）
    fn empty_line() -> Vec<u8> {
        Vec::new()
    }

    // ---------- 基础分隔符 ----------

    #[test]
    fn feed_empty_returns_nothing() {
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"").is_empty());
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_lf_terminated_line() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"hello\n"), vec![bytes("hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_cr_terminated_line() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"hello\r"), vec![bytes("hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_keeps_line_free_of_separator_bytes() {
        let mut asm = LogLineAssembler::new();
        let lines = asm.feed(&[0x41, 0x0a, 0x42, 0x0d]);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], vec![0x41]);
        assert!(!lines[0].contains(&0x0a));
        assert_eq!(lines[1], vec![0x42]);
    }

    #[test]
    fn feed_handles_full_binary_byte_range() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(&[0x00, 0x7f, 0x80, 0xff, 0x0a]),
            vec![vec![0x00, 0x7f, 0x80, 0xff]]
        );
    }

    // ---------- CRLF 对处理 ----------

    #[test]
    fn feed_crlf_pair_within_one_feed_is_one_separator() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"AB\r\nCD\n"), vec![bytes("AB"), bytes("CD")]);
    }

    #[test]
    fn feed_crlf_pair_split_across_two_feeds_is_one_separator() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"AB\r"), vec![bytes("AB")]);
        // LF 是上一 feed CR 的后半：必须被静默吞掉，不能产生空行
        assert_eq!(asm.feed(b"\nCD\n"), vec![bytes("CD")]);
    }

    #[test]
    fn feed_crlf_pair_straddling_two_feeds_then_more_data() {
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"hel").is_empty());
        assert_eq!(asm.feed(b"lo\r\nX"), vec![bytes("hello")]);
        assert!(asm.has_pending());
        assert_eq!(asm.take_tail(), Some(bytes("X")));
    }

    #[test]
    fn feed_does_not_swallow_non_lf_after_cr_across_feeds() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"X\r"), vec![bytes("X")]);
        // 下一段以 'Y' 开头：pending_cr 被清除，Y 正常进入下一行
        assert_eq!(asm.feed(b"YZ\n"), vec![bytes("YZ")]);
    }

    #[test]
    fn feed_emits_empty_line_for_bare_crlf_between_text_lines() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(b"a\r\n\r\nb\n"),
            vec![bytes("a"), empty_line(), bytes("b")]
        );
    }

    #[test]
    fn feed_clears_pending_cr_after_normal_byte() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"a\r");
        asm.feed(b"b");
        // CR 后的字节已正常处理；此时到来的 LF 是**新的**分隔符
        assert_eq!(asm.feed(b"\n"), vec![bytes("b")]);
    }

    // ---------- 连续分隔符 / 空行 ----------

    #[test]
    fn feed_emits_one_empty_chunk_per_consecutive_lf() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(b"\n\n\n"),
            vec![empty_line(), empty_line(), empty_line()]
        );
    }

    #[test]
    fn feed_emits_one_empty_chunk_per_consecutive_cr() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"\r\r"), vec![empty_line(), empty_line()]);
    }

    #[test]
    fn feed_emits_one_empty_chunk_per_crlf_pair_in_separator_only_feed() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"\r\n\r\n"), vec![empty_line(), empty_line()]);
    }

    #[test]
    fn feed_handles_interleaved_cr_lf_crlf_separators() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(
            asm.feed(b"a\rb\nc\r\nd\n"),
            vec![bytes("a"), bytes("b"), bytes("c"), bytes("d")]
        );
    }

    // ---------- feed 边界 ----------

    #[test]
    fn feed_keeps_unterminated_tail_pending_until_next_separator() {
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"hel").is_empty());
        assert!(asm.has_pending());
        assert_eq!(asm.feed(b"lo\n"), vec![bytes("hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_fragmented_response_matches_single_feed() {
        // 跨事件的 "H" + "ello\r\n" 必须聚合成一行 "Hello"
        let mut asm = LogLineAssembler::new();
        assert!(asm.feed(b"H").is_empty());
        assert_eq!(asm.feed(b"ello\r\n"), vec![bytes("Hello")]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_byte_by_byte_matches_whole_feed() {
        let stream = b"hello\r\nworld\rend\nlast\n";
        let mut whole = LogLineAssembler::new();
        let expected = whole.feed(stream);

        let mut stepwise = LogLineAssembler::new();
        let mut collected: Vec<Vec<u8>> = Vec::new();
        for &c in stream {
            collected.extend(stepwise.feed(&[c]));
        }

        assert_eq!(collected, expected);
        assert_eq!(
            collected,
            vec![bytes("hello"), bytes("world"), bytes("end"), bytes("last")]
        );
    }

    #[test]
    fn feed_handles_split_at_every_byte_of_lf_stream() {
        let stream = b"ab\ncd\n";
        for split_at in 0..=stream.len() {
            let mut asm = LogLineAssembler::new();
            let mut out: Vec<Vec<u8>> = Vec::new();
            out.extend(asm.feed(&stream[..split_at]));
            out.extend(asm.feed(&stream[split_at..]));
            assert_eq!(out, vec![bytes("ab"), bytes("cd")], "split at {split_at}");
        }
    }

    #[test]
    fn feed_handles_split_at_every_byte_of_crlf_stream() {
        let stream = b"ab\r\ncd\r\n";
        for split_at in 0..=stream.len() {
            let mut asm = LogLineAssembler::new();
            let mut out: Vec<Vec<u8>> = Vec::new();
            out.extend(asm.feed(&stream[..split_at]));
            out.extend(asm.feed(&stream[split_at..]));
            assert_eq!(out, vec![bytes("ab"), bytes("cd")], "split at {split_at}");
        }
    }

    #[test]
    fn feed_returns_independent_line_buffers() {
        let mut asm = LogLineAssembler::new();
        let input = bytes("ab\ncd\n");
        let lines = asm.feed(&input);
        assert_eq!(lines, vec![bytes("ab"), bytes("cd")]);
        // 输入未被修改；返回块是独立分配
        assert_eq!(input, bytes("ab\ncd\n"));
    }

    // ---------- 强制发射 ----------

    #[test]
    fn feed_force_flushes_at_custom_threshold_without_separator() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(asm.feed(&[1, 2, 3, 4]), vec![vec![1, 2, 3, 4]]);
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_emits_multiple_force_flush_chunks_on_long_separator_less_stream() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        // 注意避开 10 (0x0A=LF) / 13 (0x0D=CR)——它们是分隔符
        assert_eq!(
            asm.feed(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 11]),
            vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]]
        );
        assert_eq!(asm.take_tail(), Some(vec![9, 11]));
    }

    #[test]
    fn feed_continues_scanning_after_mid_feed_force_flush() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        // 4 字节强制发射，随后 5|LF、6 7|CRLF 正常按行切
        assert_eq!(
            asm.feed(&[1, 2, 3, 4, 5, 0x0a, 6, 7, 0x0d, 0x0a]),
            vec![vec![1, 2, 3, 4], vec![5], vec![6, 7]]
        );
        assert!(!asm.has_pending());
    }

    #[test]
    fn feed_resumes_normal_accumulation_after_force_flush() {
        let mut asm = LogLineAssembler::with_max_pending(3);
        assert_eq!(asm.feed(&[1, 2, 3, 4, 0x0a]), vec![vec![1, 2, 3], vec![4]]);
    }

    #[test]
    fn feed_uses_default_4096_threshold() {
        let mut asm = LogLineAssembler::new();
        let bulk = vec![0x61u8; 4096];
        assert_eq!(asm.feed(&bulk), vec![vec![0x61u8; 4096]]);
        // 再多 1 字节不会触发第二次发射（未达阈值），留在 pending
        assert!(asm.feed(&[0x62]).is_empty());
        assert_eq!(asm.take_tail(), Some(vec![0x62]));
    }

    // ---------- 强制发射后紧跟分隔符：不得产出幻影空行 ----------

    #[test]
    fn force_flush_then_lf_emits_no_phantom_empty_line() {
        // 幻影空行回归：强制发射已把该行内容交付，紧跟的 LF 只是它的行终止符。
        // 若这里多出一个空块，日志层就会写出「[ts] RX 」这种无内容行。
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(asm.feed(&[1, 2, 3, 4, 0x0a]), vec![vec![1, 2, 3, 4]]);
        assert!(!asm.has_pending());
        // 分隔符已消费：下一行从头开始累积
        assert_eq!(asm.feed(&[5, 0x0a]), vec![vec![5]]);
    }

    #[test]
    fn force_flush_then_crlf_emits_no_phantom_empty_line() {
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(
            asm.feed(&[1, 2, 3, 4, 0x0d, 0x0a, 0x62, 0x0a]),
            vec![vec![1, 2, 3, 4], vec![0x62]]
        );
        assert!(!asm.has_pending());
    }

    #[test]
    fn force_flush_then_separator_split_across_feeds() {
        // 强制发射 → 分隔符在下一个事件里到来（串口读边界最刁钻的情况）
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(asm.feed(&[1, 2, 3, 4]), vec![vec![1, 2, 3, 4]]);
        assert!(asm.feed(&[0x0d]).is_empty());
        assert!(asm.feed(&[0x0a]).is_empty());
        assert_eq!(asm.feed(b"b\n"), vec![bytes("b")]);
    }

    #[test]
    fn force_flush_then_consecutive_separators_only_swallow_the_first() {
        // 第一个分隔符终结已发射行（吞掉）；后续分隔符仍是真实空行
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(
            asm.feed(&[1, 2, 3, 4, 0x0a, 0x0a]),
            vec![vec![1, 2, 3, 4], empty_line()]
        );
    }

    #[test]
    fn take_tail_clears_just_forced_before_the_separator_arrives() {
        // take_tail 把「未终结的行走廊」清空后，紧跟的分隔符属于新的一行（空行）——
        // 与前端 takeTail() 清除 justForced 的语义一致。
        let mut asm = LogLineAssembler::with_max_pending(4);
        assert_eq!(asm.feed(&[1, 2, 3, 4]), vec![vec![1, 2, 3, 4]]);
        assert_eq!(asm.take_tail(), None);
        assert_eq!(asm.feed(&[0x0a]), vec![empty_line()]);
    }

    // ---------- take_tail / has_pending ----------

    #[test]
    fn take_tail_returns_pending_bytes() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"partial");
        assert_eq!(asm.take_tail(), Some(bytes("partial")));
        assert!(!asm.has_pending());
    }

    #[test]
    fn take_tail_returns_none_when_nothing_pending() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"done\n");
        assert_eq!(asm.take_tail(), None);
    }

    #[test]
    fn take_tail_resets_state_so_next_feed_starts_fresh_line() {
        let mut asm = LogLineAssembler::new();
        asm.feed(b"old");
        assert!(asm.take_tail().is_some());
        assert_eq!(asm.feed(b"new\n"), vec![bytes("new")]);
    }

    #[test]
    fn take_tail_clears_pending_cr_so_following_lf_is_real_separator() {
        let mut asm = LogLineAssembler::new();
        assert_eq!(asm.feed(b"a\r"), vec![bytes("a")]);
        asm.take_tail(); // 清除 pending_cr
        // LF 不再是「CRLF 后半」，而是新行的分隔符 → 发射空行
        assert_eq!(asm.feed(b"\n"), vec![empty_line()]);
    }

    #[test]
    fn has_pending_reflects_buffer_state_across_feeds() {
        let mut asm = LogLineAssembler::new();
        assert!(!asm.has_pending());
        asm.feed(b"x");
        assert!(asm.has_pending());
        asm.feed(b"\n");
        assert!(!asm.has_pending());
    }
}
