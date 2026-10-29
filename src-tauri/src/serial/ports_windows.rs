use std::collections::{HashMap, HashSet};
use std::io;

use anyhow::Context;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, RegType};
use winreg::types::FromRegValue;
use winreg::RegKey;

use super::PortInfo;

const SERIALCOMM_KEY: &str = r"HARDWARE\DEVICEMAP\SERIALCOMM";

/// Enumerate registry values in their native RegEnumValue order.
/// This is the same ordering used by .NET SerialPort.GetPortNames().
pub(super) fn enumerate() -> anyhow::Result<Vec<PortInfo>> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let key = match hklm.open_subkey_with_flags(SERIALCOMM_KEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("open SERIALCOMM registry key"),
    };

    let mut names = Vec::new();
    for value in key.enum_values() {
        let (_value_name, value) = value.context("enumerate SERIALCOMM registry values")?;
        if value.vtype != RegType::REG_SZ && value.vtype != RegType::REG_EXPAND_SZ {
            continue;
        }
        let text = String::from_reg_value(&value).context("decode SERIALCOMM port name")?;
        if is_com_name(&text) {
            names.push(text);
        }
    }
    names = dedupe_names(names);
    if names.is_empty() {
        return Ok(Vec::new());
    }

    // Metadata is optional: the registry remains authoritative for membership and order.
    let mut metadata = match serialport::available_ports() {
        Ok(ports) => ports
            .into_iter()
            .map(|port| (port.port_name, port.port_type))
            .collect::<HashMap<_, _>>(),
        Err(error) => {
            log::warn!("serial port metadata lookup failed; using registry names: {error}");
            HashMap::new()
        }
    };

    Ok(names
        .into_iter()
        .map(|name| {
            let (manufacturer, product) = metadata
                .remove(&name)
                .and_then(|port_type| match port_type {
                    serialport::SerialPortType::UsbPort(info) => {
                        Some((info.manufacturer, info.product))
                    }
                    _ => None,
                })
                .unwrap_or((None, None));
            PortInfo {
                id: name.clone(),
                name,
                port_type: "real".to_string(),
                manufacturer,
                product,
            }
        })
        .collect())
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
    use super::{dedupe_names, is_com_name};

    #[test]
    fn accepts_only_numeric_com_names() {
        assert!(is_com_name("COM1"));
        assert!(is_com_name("com42"));
        assert!(!is_com_name("COM"));
        assert!(!is_com_name("COMx"));
        assert!(!is_com_name("LPT1"));
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
}
