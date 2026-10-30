//! Bounded, identity-free page controls. The native session supplies instance and
//! document identity; pages cannot nominate another tab, port, participant or group.
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    action: String,
    capability_generation: String,
    registration: Option<Registration>,
    capabilities: Option<Capabilities>,
    availability: Option<Availability>,
    gesture_id: Option<String>,
    intent: Option<String>,
    anchor: Option<Anchor>,
    request_id: Option<String>,
    result: Option<SeekResult>,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration { version: u8, clock: Clock, capabilities: Capabilities }
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Clock { BoundInput, Custom { id: String } }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capabilities { preview: String, can_drive: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Availability { available: bool, range: Option<Range> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Range { start_ms: f64, end_ms: f64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Anchor { time_ms: f64, record_key: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SeekResult { status: String, actual_time_ms: Option<f64>, record_key: Option<String> }
fn text(value: &str) -> bool { !value.is_empty() && value.len() <= 128 }
fn key(value: Option<&str>) -> bool { value.is_none_or(|s| s.len() <= 128) }
fn capabilities(value: &Capabilities) -> bool { let _ = value.can_drive; matches!(value.preview.as_str(), "bounded" | "commit-only") }
fn anchor(value: &Anchor) -> bool { value.time_ms.is_finite() && key(value.record_key.as_deref()) }
fn status(value: &str) -> bool { matches!(value, "exact" | "nearest" | "before-range" | "after-range" | "no-time" | "filtered" | "held" | "loading" | "unsupported") }
pub(super) fn preview(value: &Value) -> bool { value.get("action").and_then(Value::as_str) == Some("update") }
pub(super) fn validate_page(value: &Value) -> bool {
    if serde_json::to_vec(value).map_or(true, |v| v.len() > 4096) { return false; }
    let Ok(message) = serde_json::from_value::<Envelope>(value.clone()) else { return false; };
    if uuid::Uuid::parse_str(&message.capability_generation).is_err() { return false; }
    match message.action.as_str() {
        "register" => message.registration.as_ref().is_some_and(|r| r.version == 1 && capabilities(&r.capabilities) && match &r.clock { Clock::BoundInput => true, Clock::Custom { id } => text(id) }),
        "capabilities" => message.capabilities.as_ref().is_some_and(capabilities),
        "availability" => message.availability.as_ref().is_some_and(|a| { let _ = a.available; a.range.as_ref().is_none_or(|r| r.start_ms.is_finite() && r.end_ms.is_finite() && r.start_ms <= r.end_ms) }),
        "begin" => message.gesture_id.as_deref().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()) && message.intent.as_deref().is_some_and(|s| matches!(s, "scrollbar" | "wheel" | "keyboard" | "search" | "jump" | "align" | "scrub")),
        "update" => message.gesture_id.as_deref().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()) && message.anchor.as_ref().is_some_and(anchor),
        "end" | "cancel" => message.gesture_id.as_deref().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()) && message.anchor.as_ref().is_none_or(anchor),
        "ack" => message.request_id.as_deref().is_some_and(text) && message.result.as_ref().is_some_and(|r| status(&r.status) && (!matches!(r.status.as_str(), "exact" | "nearest" | "before-range" | "after-range") || r.actual_time_ms.is_some_and(f64::is_finite)) && r.actual_time_ms.is_none_or(f64::is_finite) && key(r.record_key.as_deref())) && message.error.as_ref().is_none_or(|s| s.len() <= 2048),
        "dispose" => true,
        _ => false,
    }
}
pub(super) fn validate_host(message: &Value) -> bool {
    if serde_json::to_vec(message).map_or(true, |v| v.len() > 8192) { return false; }
    if message["type"] == "timeline-cancel" {
        return message["capabilityGeneration"].as_str().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()) && message["requestId"].as_str().is_some_and(text);
    }
    let request = &message["timeline"];
    request["capabilityGeneration"].as_str().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        && request["requestId"].as_str().is_some_and(text)
        && request["timeMs"].as_f64().is_some_and(f64::is_finite)
        && request["phase"].as_str().is_some_and(|s| matches!(s, "preview" | "commit"))
        && ["groupId", "gestureId"].iter().all(|k| request[k].as_str().is_some_and(text))
        && ["navigationEpoch", "requestSeq", "mappingRevision", "participantGeneration", "sourceGeneration"].iter().all(|k| request[k].as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
        && request["align"] == "center"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shipped_workerless_example_passes_native_manifest_and_resource_validation() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugin-views-demo/workerless");
        let manifest = crate::plugin::load_manifest_from_dir(&directory).unwrap();
        assert!(manifest.entry.is_empty());
        let view = &manifest.ui.as_ref().unwrap().views[0];
        assert!(!view.worker); assert!(view.is_trusted_web()); assert_eq!(view.input, "none");
        assert!(super::super::resources::snapshot(&directory, view).is_ok());
    }
    #[test]
    fn host_timeline_controls_require_complete_safe_versions_and_small_envelopes() {
        let generation = uuid::Uuid::new_v4().to_string();
        let mut message = serde_json::json!({"type":"timeline-seek","documentId":uuid::Uuid::new_v4().to_string(),"timeline":{"requestId":"seek","capabilityGeneration":generation,"groupId":"group","navigationEpoch":1,"gestureId":"gesture","requestSeq":2,"mappingRevision":3,"participantGeneration":4,"sourceGeneration":5,"timeMs":1234.5,"phase":"commit","align":"center"}});
        assert!(validate_host(&message));
        message["timeline"]["mappingRevision"] = (-1).into(); assert!(!validate_host(&message));
        message["timeline"]["mappingRevision"] = 3.into(); message["timeline"]["phase"] = "state".into(); assert!(!validate_host(&message));
        message["timeline"]["phase"] = "commit".into(); message["timeline"]["groupId"] = "".into(); assert!(!validate_host(&message));
        assert!(validate_host(&serde_json::json!({"type":"timeline-cancel","capabilityGeneration":generation,"requestId":"seek"})));
        message["timeline"]["groupId"] = "group".into(); message["padding"] = "x".repeat(8192).into(); assert!(!validate_host(&message));
    }
    #[test]
    fn optional_timeline_controls_have_no_self_reported_host_identity() {
        let generation = uuid::Uuid::new_v4().to_string();
        let mut value = serde_json::json!({"action":"register", "capabilityGeneration":generation, "registration":{"version":1,"clock":{"kind":"custom","id":"device"},"capabilities":{"preview":"commit-only","canDrive":true}}});
        assert!(validate_page(&value));
        value["portId"] = "COM7".into(); assert!(!validate_page(&value));
        value.as_object_mut().unwrap().remove("portId");
        value["registration"]["clock"]["kind"] = "host-clock".into(); assert!(!validate_page(&value));
    }
    #[test]
    fn timeline_final_controls_and_ack_are_bounded_and_validated() {
        let generation = uuid::Uuid::new_v4().to_string();
        let gesture = uuid::Uuid::new_v4().to_string();
        let value = serde_json::json!({"action":"end","capabilityGeneration":generation,"gestureId":gesture,"anchor":{"timeMs":123.5,"recordKey":"row"}});
        assert!(validate_page(&value)); assert!(!preview(&value));
        let mut ack = serde_json::json!({"action":"ack","capabilityGeneration":generation,"requestId":"request","result":{"status":"nearest","actualTimeMs":123.5}});
        assert!(validate_page(&ack)); ack["result"]["status"] = "queued".into(); assert!(!validate_page(&ack));
        ack["result"]["status"] = "nearest".into(); ack["result"]["recordKey"] = "x".repeat(129).into(); assert!(!validate_page(&ack));
    }
}
