//! Shared HyperCom control protocol, local IPC, pinned TLS 1.3, and
//! authentication/credential store crate for `hypercom_lib` and `hypercomctl`.

pub mod auth;
pub mod client;
pub mod expect;
pub mod ipc;
pub mod protocol;
pub mod tls;

pub use auth::{
    load_profile, preflight_profile, reserve_profile_name, save_profile, Access, Authority, Peer,
    ProfileReservation, ProfileStore, RemoteClientDto, RemoteInvite, RemotePermissions,
    RemoteProfile, RemoteRole, RemoteStatusDto, StoredProfile,
};
pub use client::{AsyncControlClient, ControlClient};
pub use expect::{ExpectMatcher, ExpectPattern};
pub use ipc::{
    connect_local_stream, validate_endpoint_name, BoxedStream, IpcStream, LocalListener,
};
pub use protocol::{
    read_frame, read_json_frame, read_limited_frame, write_frame, write_json_frame,
    ArtifactInfoDto, ControlCommand, EventPageDto, ExpectSpec, FrameEnvelope, HostError,
    LoanInfoDto, PluginJobEventDto, PluginJobStatusDto, PluginToolDescriptorDto,
    PluginToolInvokeResultDto, PortRef, PortSnapshotDto, RemotePluginViewEntryDto,
    RemoteViewAssetDto, RemoteViewEventDto, RemoteViewEventPageDto, RemoteViewSessionDto,
    ReplyEnvelope, RequestOutcomeDto, SerialParamsDto, SerialRecoveryDto, StreamEventDto,
    DEFAULT_ENDPOINT, MAX_ARTIFACT_CHUNK_BYTES, MAX_EXPECT_BYTES, MAX_EXPECT_MS,
    MAX_FRAME_BYTES, MAX_POLL_MS, MAX_WRITE_BYTES, PROTOCOL_VERSION,
};
pub use tls::{
    build_tls_acceptor, build_tls_acceptor_from_der, connect_pinned_tls, decode_sha256_pin,
    validate_remote_endpoint, CONTROL_ALPN,
};
