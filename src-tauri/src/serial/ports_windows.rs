use std::collections::{HashMap, HashSet};
use std::io;

use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, RegType};
use winreg::types::FromRegValue;
use winreg::RegKey;

use super::PortInfo;

const SERIALCOMM_KEY: &str = r"HARDWARE\DEVICEMAP\SERIALCOMM";

/// Enumerate COM ports in registry order (same ordering as .NET
/// `SerialPort.GetPortNames()`), with SetupAPI staying a fallback source.
///
/// Failure policy: the registry is authoritative for membership **and order** when
/// it is readable, but it must never turn a whole list call into an error. A
/// restricted/corrupt key falls back to SetupAPI; a single undecodable value is
/// skipped with a warning (the old `serialport`-based implementation was equally
/// tolerant, so a locked-down registry used to still show ports).
pub(super) fn enumerate() -> anyhow::Result<Vec<PortInfo>> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut registry_names = Vec::new();
    match hklm.open_subkey_with_flags(SERIALCOMM_KEY, KEY_READ) {
        Ok(key) => {
            for value in key.enum_values() {
                match value {
                    Ok((_name, value)) => {
                        let vtype = value.vtype.clone();
                        if let Some(port) = registry_port_name(vtype, &value) {
                            registry_names.push(port);
                        }
                    }
                    Err(error) => log::warn!("skipping SERIALCOMM value: {error}"),
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            log::debug!("SERIALCOMM key missing; falling back to SetupAPI");
        }
        Err(error) => log::warn!("SERIALCOMM unreadable ({error}); falling back to SetupAPI"),
    }

    let registry_names = dedupe_names(registry_names);
    // Metadata (and the fallback membership) comes from SetupAPI. It is optional:
    // a metadata failure must not hide registry ports.
    let metadata = match serialport::available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            log::warn!("serial port metadata lookup failed; using registry names: {error}");
            Vec::new()
        }
    };

    if registry_names.is_empty() {
        // Registry unavailable/empty: keep the pre-existing SetupAPI membership so
        // ports still appear on machines with an empty SERIALCOMM key.
        return Ok(metadata
            .into_iter()
            .map(|port| {
                let meta = usb_metadata(port.port_type);
                PortInfo {
                    id: port.port_name.clone(),
                    name: port.port_name,
                    port_type: "real".to_string(),
                    manufacturer: meta.manufacturer,
                    product: meta.product,
                }
            })
            .collect());
    }

    let mut by_name = metadata
        .into_iter()
        .map(|port| (port.port_name, port.port_type))
        .collect::<HashMap<_, _>>();
    Ok(registry_names
        .into_iter()
        .map(|name| {
            let meta = by_name.remove(&name).map(usb_metadata).unwrap_or_default();
            PortInfo {
                id: name.clone(),
                name,
                port_type: "real".to_string(),
                manufacturer: meta.manufacturer,
                product: meta.product,
            }
        })
        .collect())
}

fn usb_metadata(port_type: serialport::SerialPortType) -> PortMetadata {
    match port_type {
        serialport::SerialPortType::UsbPort(info) => PortMetadata {
            manufacturer: info.manufacturer,
            product: info.product,
        },
        _ => PortMetadata::default(),
    }
}

#[derive(Default)]
struct PortMetadata {
    manufacturer: Option<String>,
    product: Option<String>,
}

/// Decode one SERIALCOMM value into a COM port name.
///
/// `REG_EXPAND_SZ` values are expanded like .NET's `RegistryKey.GetValue` does
/// (the old implementation used the raw text, so `%VAR%` values were silently
/// dropped); expansion failure falls back to the raw text with a warning. Values
/// that are not `COM<digits>` are ignored.
fn registry_port_name(vtype: RegType, value: &winreg::RegValue) -> Option<String> {
    if vtype != RegType::REG_SZ && vtype != RegType::REG_EXPAND_SZ {
        return None;
    }
    let Ok(text) = String::from_reg_value(value) else {
        log::warn!("SERIALCOMM value is not valid UTF-16; skipping");
        return None;
    };
    let text = if vtype == RegType::REG_EXPAND_SZ {
        expand_environment(&text)
    } else {
        text
    };
    is_com_name(&text).then_some(text)
}

/// Expand `%VAR%` references (the semantics .NET applies to `REG_EXPAND_SZ`).
///
/// Variables are resolved through `std::env` (case-insensitive on Windows, like
/// `GetEnvironmentVariableW`); an unresolved name keeps its literal `%NAME%` text,
/// matching the platform behaviour instead of silently emptying the value.
fn expand_environment(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let next = text[index..].chars().next().unwrap_or('%');
            out.push(next);
            index += next.len_utf8();
            continue;
        }
        match text[index + 1..].find('%') {
            Some(end_offset) => {
                let name = &text[index + 1..index + 1 + end_offset];
                match std::env::var(name) {
                    Ok(value) => out.push_str(&value),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                index += 1 + end_offset + 1;
            }
            None => {
                out.push_str(&text[index..]);
                break;
            }
        }
    }
    out
}

fn is_com_name(name: &str) -> bool {
    let suffix = name
        .get(..3)
        .filter(|prefix| prefix.eq_ignore_ascii_case("COM"))
        .and_then(|_| name.get(3..))
        .unwrap_or("");
    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
}

fn dedupe_names(mut names: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::with_capacity(names.len());
    names.retain(|name| seen.insert(name.to_ascii_uppercase()));
    names
}

#[cfg(test)]
mod tests {
    use super::{dedupe_names, is_com_name, registry_port_name};
    use winreg::enums::RegType;
    use winreg::types::ToRegValue;

    fn value(text: &str) -> winreg::RegValue {
        text.to_reg_value()
    }

    #[test]
    fn accepts_only_numeric_com_names() {
        assert!(is_com_name("COM1"));
        assert!(is_com_name("com42"));
        assert!(!is_com_name("COM"));
        assert!(!is_com_name("COMx"));
        assert!(!is_com_name("COM1A"));
        assert!(!is_com_name("LPT1"));
        assert!(!is_com_name(""));
    }

    #[test]
    fn preserves_registry_order_and_first_duplicate() {
        assert_eq!(
            dedupe_names(vec![
                "COM10".to_string(),
                "COM2".to_string(),
                "com10".to_string(),
                "COM1".to_string(),
            ]),
            ["COM10", "COM2", "COM1"]
        );
    }

    #[test]
    fn registry_values_filter_by_type_and_name() {
        assert_eq!(
            registry_port_name(RegType::REG_SZ, &value("COM7")).as_deref(),
            Some("COM7")
        );
        // Non-string values and non-COM names are skipped, not fatal.
        assert_eq!(registry_port_name(RegType::REG_DWORD, &value("COM7")), None);
        assert_eq!(registry_port_name(RegType::REG_SZ, &value("LPT1")), None);
        assert_eq!(registry_port_name(RegType::REG_SZ, &value("COM")), None);
    }

    #[test]
    fn expand_sz_values_are_expanded_before_validation() {
        // No environment variable is involved: expansion is identity, so the value
        // still passes the COM filter (raw `%...%` text would be dropped).
        assert_eq!(
            registry_port_name(RegType::REG_EXPAND_SZ, &value("COM9")).as_deref(),
            Some("COM9")
        );
        assert_eq!(
            registry_port_name(RegType::REG_EXPAND_SZ, &value("%NOSUCHVAR%\\COM9")),
            None,
            "unresolved variables stay literal, so the name is not a bare COM port"
        );
    }
}
