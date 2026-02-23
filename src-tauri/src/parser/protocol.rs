use serde::{Deserialize, Serialize};

/// 字段类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    /// 无符号整数
    Uint8,
    Uint16,
    Uint32,
    Uint64,
    /// 有符号整数
    Int8,
    Int16,
    Int32,
    Int64,
    /// 浮点数
    Float32,
    Float64,
    /// 字符串
    String,
    /// 字节数组
    Bytes,
    /// 十六进制
    Hex,
}

impl FieldType {
    /// 获取字段类型的字节大小
    pub fn size(&self) -> Option<usize> {
        match self {
            FieldType::Uint8 | FieldType::Int8 => Some(1),
            FieldType::Uint16 | FieldType::Int16 => Some(2),
            FieldType::Uint32 | FieldType::Int32 | FieldType::Float32 => Some(4),
            FieldType::Uint64 | FieldType::Int64 | FieldType::Float64 => Some(8),
            FieldType::String | FieldType::Bytes | FieldType::Hex => None,
        }
    }
}

/// 字节序
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ByteOrder {
    /// 大端序
    BigEndian,
    /// 小端序
    LittleEndian,
}

impl Default for ByteOrder {
    fn default() -> Self {
        ByteOrder::BigEndian
    }
}

/// 协议字段定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolField {
    /// 字段名称
    pub name: String,
    /// 字段类型
    pub field_type: FieldType,
    /// 字节偏移量
    pub offset: usize,
    /// 字段长度（用于 String, Bytes, Hex 类型）
    pub length: Option<usize>,
    /// 字节序
    pub byte_order: ByteOrder,
    /// 描述
    pub description: Option<String>,
    /// 是否显示
    pub visible: bool,
}

impl ProtocolField {
    #[allow(dead_code)]
    pub fn new(name: &str, field_type: FieldType, offset: usize) -> Self {
        Self {
            name: name.to_string(),
            field_type,
            offset,
            length: None,
            byte_order: ByteOrder::default(),
            description: None,
            visible: true,
        }
    }

    #[allow(dead_code)]
    pub fn with_length(mut self, length: usize) -> Self {
        self.length = Some(length);
        self
    }

    #[allow(dead_code)]
    pub fn with_byte_order(mut self, order: ByteOrder) -> Self {
        self.byte_order = order;
        self
    }

    #[allow(dead_code)]
    pub fn with_description(mut self, description: &str) -> Self {
        self.description = Some(description.to_string());
        self
    }
}

/// 协议定义
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Protocol {
    /// 协议 ID
    pub id: String,
    /// 协议名称
    pub name: String,
    /// 协议描述
    pub description: Option<String>,
    /// 帧头
    pub header: Option<Vec<u8>>,
    /// 帧尾
    pub footer: Option<Vec<u8>>,
    /// 字段列表
    pub fields: Vec<ProtocolField>,
    /// 校验类型
    pub checksum: Option<ChecksumType>,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

#[allow(dead_code)]
impl Protocol {
    pub fn new(name: &str) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            description: None,
            header: None,
            footer: None,
            fields: Vec::new(),
            checksum: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_header(mut self, header: Vec<u8>) -> Self {
        self.header = Some(header);
        self
    }

    pub fn with_footer(mut self, footer: Vec<u8>) -> Self {
        self.footer = Some(footer);
        self
    }

    pub fn add_field(&mut self, field: ProtocolField) {
        self.fields.push(field);
        self.updated_at = chrono::Utc::now().timestamp_millis();
    }

    /// 获取协议最小帧长度
    pub fn min_frame_length(&self) -> usize {
        let header_len = self.header.as_ref().map(|h| h.len()).unwrap_or(0);
        let footer_len = self.footer.as_ref().map(|f| f.len()).unwrap_or(0);
        let checksum_len = self.checksum.as_ref().map(|c| c.size()).unwrap_or(0);

        let fields_end = self.fields.iter().map(|f| {
            let size = f.field_type.size().or(f.length).unwrap_or(1);
            f.offset + size
        }).max().unwrap_or(0);

        header_len + fields_end + footer_len + checksum_len
    }
}

/// 校验类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChecksumType {
    /// 无校验
    None,
    /// 累加和
    Sum8,
    Sum16,
    /// CRC 校验
    Crc8,
    Crc16,
    Crc32,
    /// 异或校验
    Xor8,
}

#[allow(dead_code)]
impl ChecksumType {
    /// 获取校验值的字节长度
    pub fn size(&self) -> usize {
        match self {
            ChecksumType::None => 0,
            ChecksumType::Sum8 | ChecksumType::Crc8 | ChecksumType::Xor8 => 1,
            ChecksumType::Sum16 | ChecksumType::Crc16 => 2,
            ChecksumType::Crc32 => 4,
        }
    }
}

impl Default for ChecksumType {
    fn default() -> Self {
        ChecksumType::None
    }
}

/// 解析后的字段值
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedField {
    /// 字段名称
    pub name: String,
    /// 字段类型
    pub field_type: FieldType,
    /// 原始字节
    pub raw_bytes: Vec<u8>,
    /// 解析后的值
    pub value: String,
    /// 描述
    pub description: Option<String>,
}

/// 解析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFrame {
    /// 协议名称
    pub protocol_name: String,
    /// 原始数据
    pub raw_data: Vec<u8>,
    /// 解析后的字段
    pub fields: Vec<ParsedField>,
    /// 是否有效
    pub valid: bool,
    /// 错误信息
    pub error: Option<String>,
}
