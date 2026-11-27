use super::BoxedStream;
use std::{ffi::c_void, io, os::windows::io::AsRawHandle, ptr};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, PipeMode, ServerOptions};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_PIPE_BUSY, HANDLE},
    Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    },
    Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    },
    Storage::FileSystem::SECURITY_IDENTIFICATION,
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn sid_for_process(process: HANDLE) -> io::Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    let mut size = 0u32;
    if unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size) } != 0
        || io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
        || size < std::mem::size_of::<TOKEN_USER>() as u32
        || size > 65536
    {
        return Err(io::Error::other("could not size Windows token user SID"));
    }
    // The supplied buffer must align TOKEN_USER (and hold its pointed-to SID).
    let mut data = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            data.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*data.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _sid_allocation = LocalAllocation(sid.cast());
    let len = (0..256)
        .find(|offset| unsafe { *sid.add(*offset) == 0 })
        .ok_or_else(|| io::Error::other("invalid Windows SID string"))?;
    String::from_utf16(unsafe { std::slice::from_raw_parts(sid, len) }).map_err(io::Error::other)
}

fn own_sid() -> io::Result<String> {
    sid_for_process(unsafe { GetCurrentProcess() })
}

fn address(sid: &str, name: &str) -> String {
    format!(r"\\.\pipe\HyperCom.Control.{sid}.{name}")
}

fn create(address: &str, sid: &str, first: bool) -> io::Result<NamedPipeServer> {
    // Protected DACL, with only this process's actual token user SID. Never use
    // default pipe security (which can permit other local users to connect).
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let sddl: Vec<_> = format!("D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain([0])
        .collect();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let _descriptor = LocalAllocation(descriptor.cast());
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    unsafe {
        ServerOptions::new()
            .pipe_mode(PipeMode::Byte)
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                address,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
}

pub(super) struct Listener {
    address: String,
    sid: String,
    waiting: NamedPipeServer,
}

impl Listener {
    pub(super) fn bind(name: &str) -> io::Result<Self> {
        let sid = own_sid()?;
        let address = address(&sid, name);
        let waiting = create(&address, &sid, true)?;
        Ok(Self {
            address,
            sid,
            waiting,
        })
    }

    pub(super) async fn accept(&mut self) -> io::Result<Option<BoxedStream>> {
        self.waiting.connect().await?;
        // Preserve the first-instance reservation without a gap, including
        // while the accepted pipe closes or does not respond.
        let next = create(&self.address, &self.sid, false)?;
        let connected = std::mem::replace(&mut self.waiting, next);
        Ok(Some(Box::new(connected)))
    }
}

pub(super) async fn connect(name: &str) -> io::Result<BoxedStream> {
    let sid = own_sid()?;
    let path = address(&sid, name);
    let stream = loop {
        match ClientOptions::new()
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(&path)
        {
            Ok(stream) => break stream,
            Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await
            }
            Err(err) => return Err(err),
        }
    };
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(stream.as_raw_handle().cast(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = OwnedHandle(process);
    if sid_for_process(process.0)? != sid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Host pipe server does not run as this user",
        ));
    }
    Ok(Box::new(stream))
}
