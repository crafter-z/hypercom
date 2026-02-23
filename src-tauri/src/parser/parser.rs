use super::protocol::*;
use std::collections::HashMap;
use std::sync::Mutex;

/// 协议解析器
pub struct ProtocolParser {
    /// 已注册的协议列表
    protocols: HashMap<String, Protocol>,
    /// 当前激活的协议
    active_protocol: Option<String>,
}

impl ProtocolParser {
    /// 创建新的解析器
    pub fn new() -> Self {
        Self {
            protocols: HashMap::new(),
            active_protocol: None,
        }
    }

    /// 注册协议
    pub fn register_protocol(&mut self, protocol: Protocol) {
        self.protocols.insert(protocol.id.clone(), protocol);
    }

    /// 移除协议
    pub fn remove_protocol(&mut self, id: &str) {
        self.protocols.remove(id);
        if self.active_protocol.as_deref() == Some(id) {
            self.active_protocol = None;
        }
    }

    /// 设置激活的协议
    pub fn set_active_protocol(&mut self, id: Option<String>) {
        self.active_protocol = id;
    }

    /// 获取所有协议
    pub fn get_protocols(&self) -> Vec<&Protocol> {
        self.protocols.values().collect()
    }

    /// 获取协议
    pub fn get_protocol(&self, id: &str) -> Option<&Protocol> {
        self.protocols.get(id)
    }

    /// 解析数据
    pub fn parse(&self, data: &[u8]) -> Option<ParsedFrame> {
        let protocol_id = self.active_protocol.as_ref()?;
        let protocol = self.protocols.get(protocol_id)?;

        Some(self.parse_with_protocol(data, protocol))
    }

    /// 使用指定协议解析数据
    pub fn parse_with_protocol(&self, data: &[u8], protocol: &Protocol) -> ParsedFrame {
        // 验证帧头
        if let Some(ref header) = protocol.header {
            if data.len() < header.len() {
                return ParsedFrame {
                    protocol_name: protocol.name.clone(),
                    raw_data: data.to_vec(),
                    fields: Vec::new(),
                    valid: false,
                    error: Some("数据长度不足".to_string()),
                };
            }
            if &data[..header.len()] != header.as_slice() {
                return ParsedFrame {
                    protocol_name: protocol.name.clone(),
                    raw_data: data.to_vec(),
                    fields: Vec::new(),
                    valid: false,
                    error: Some("帧头不匹配".to_string()),
                };
            }
        }

        // 验证帧尾
        if let Some(ref footer) = protocol.footer {
            if data.len() < footer.len() {
                return ParsedFrame {
                    protocol_name: protocol.name.clone(),
                    raw_data: data.to_vec(),
                    fields: Vec::new(),
                    valid: false,
                    error: Some("数据长度不足".to_string()),
                };
            }
            let footer_start = data.len() - footer.len();
            if &data[footer_start..] != footer.as_slice() {
                return ParsedFrame {
                    protocol_name: protocol.name.clone(),
                    raw_data: data.to_vec(),
                    fields: Vec::new(),
                    valid: false,
                    error: Some("帧尾不匹配".to_string()),
                };
            }
        }

        // 解析字段
        let mut fields = Vec::new();
        let header_len = protocol.header.as_ref().map(|h| h.len()).unwrap_or(0);

        for field_def in &protocol.fields {
            let abs_offset = header_len + field_def.offset;
            
            // 确定字段长度
            let field_len = match field_def.field_type.size() {
                Some(size) => size,
                None => field_def.length.unwrap_or(1),
            };

            // 检查数据长度
            if abs_offset + field_len > data.len() {
                fields.push(ParsedField {
                    name: field_def.name.clone(),
                    field_type: field_def.field_type.clone(),
                    raw_bytes: Vec::new(),
                    value: "数据不足".to_string(),
                    description: field_def.description.clone(),
                });
                continue;
            }

            // 提取原始字节
            let raw_bytes = data[abs_offset..abs_offset + field_len].to_vec();

            // 解析值
            let value = parse_field_value(&raw_bytes, &field_def.field_type, &field_def.byte_order);

            fields.push(ParsedField {
                name: field_def.name.clone(),
                field_type: field_def.field_type.clone(),
                raw_bytes,
                value,
                description: field_def.description.clone(),
            });
        }

        ParsedFrame {
            protocol_name: protocol.name.clone(),
            raw_data: data.to_vec(),
            fields,
            valid: true,
            error: None,
        }
    }
}

impl Default for ProtocolParser {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析字段值
fn parse_field_value(bytes: &[u8], field_type: &FieldType, byte_order: &ByteOrder) -> String {
    if bytes.is_empty() {
        return "空".to_string();
    }

    // 检查所需的最小长度
    let required_len = field_type.size().unwrap_or(1);
    if bytes.len() < required_len {
        return format!("数据不足(需要{}字节)", required_len);
    }

    match field_type {
        FieldType::Uint8 => {
            format!("{}", bytes[0])
        }
        FieldType::Int8 => {
            format!("{}", bytes[0] as i8)
        }
        FieldType::Uint16 => {
            let value = match byte_order {
                ByteOrder::BigEndian => u16::from_be_bytes([bytes[0], bytes[1]]),
                ByteOrder::LittleEndian => u16::from_le_bytes([bytes[0], bytes[1]]),
            };
            format!("{}", value)
        }
        FieldType::Int16 => {
            let value = match byte_order {
                ByteOrder::BigEndian => i16::from_be_bytes([bytes[0], bytes[1]]),
                ByteOrder::LittleEndian => i16::from_le_bytes([bytes[0], bytes[1]]),
            };
            format!("{}", value)
        }
        FieldType::Uint32 => {
            let value = match byte_order {
                ByteOrder::BigEndian => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
                ByteOrder::LittleEndian => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            };
            format!("{}", value)
        }
        FieldType::Int32 => {
            let value = match byte_order {
                ByteOrder::BigEndian => i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
                ByteOrder::LittleEndian => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            };
            format!("{}", value)
        }
        FieldType::Uint64 => {
            let value = match byte_order {
                ByteOrder::BigEndian => u64::from_be_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]),
                ByteOrder::LittleEndian => u64::from_le_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]),
            };
            format!("{}", value)
        }
        FieldType::Int64 => {
            let value = match byte_order {
                ByteOrder::BigEndian => i64::from_be_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]),
                ByteOrder::LittleEndian => i64::from_le_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]),
            };
            format!("{}", value)
        }
        FieldType::Float32 => {
            let value = match byte_order {
                ByteOrder::BigEndian => f32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
                ByteOrder::LittleEndian => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            };
            format!("{:.6}", value)
        }
        FieldType::Float64 => {
            let value = match byte_order {
                ByteOrder::BigEndian => f64::from_be_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]),
                ByteOrder::LittleEndian => f64::from_le_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]),
            };
            format!("{:.10}", value)
        }
        FieldType::String => {
            String::from_utf8_lossy(bytes).to_string()
        }
        FieldType::Bytes => {
            bytes.iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" ")
        }
        FieldType::Hex => {
            bytes.iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" ")
        }
    }
}

/// 解析器状态
pub struct ParserState {
    pub parser: Mutex<ProtocolParser>,
}

impl ParserState {
    pub fn new() -> Self {
        Self {
            parser: Mutex::new(ProtocolParser::new()),
        }
    }
}

impl Default for ParserState {
    fn default() -> Self {
        Self::new()
    }
}
