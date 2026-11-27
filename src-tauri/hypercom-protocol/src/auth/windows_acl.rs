//! Existing storage must already be protected from other accounts. This module
//! never writes a DACL, owner, access token or user directory permission.
use std::{
    ffi::c_void,
    io,
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
    ptr::{addr_of, null_mut},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT},
    Security::{
        EqualSid, GetAce, GetTokenInformation, IsValidSid, IsWellKnownSid, TokenUser,
        WinBuiltinAdministratorsSid, WinCreatorOwnerSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
        ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

const DELETE: u32 = 0x0001_0000;
const WRITE_DAC: u32 = 0x0004_0000;
const WRITE_OWNER: u32 = 0x0008_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const GENERIC_ALL: u32 = 0x1000_0000;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
const FILE_DELETE_CHILD: u32 = 0x0040;
const FILE_WRITE_DATA_OR_ADD_FILE: u32 = 0x0002;
const FILE_APPEND_DATA_OR_ADD_SUBDIR: u32 = 0x0004;
const FILE_WRITE_EA: u32 = 0x0010;
const INHERIT_ONLY: u8 = 0x08;

#[repr(C)]
struct ServiceSid {
    header: [u8; 8],
    sub_auth: [u32; 6],
}

// Exact NT SERVICE\TrustedInstaller identity.
static TRUSTED_INSTALLER: ServiceSid = ServiceSid {
    header: [1, 6, 0, 0, 0, 0, 0, 5],
    sub_auth: [
        80, 956008885, 3418522649, 1831038044, 1853292631, 2271478464,
    ],
};

const ANCESTOR_MUTATION: u32 = DELETE
    | WRITE_DAC
    | WRITE_OWNER
    | GENERIC_WRITE
    | GENERIC_ALL
    | FILE_DELETE_CHILD
    | FILE_WRITE_ATTRIBUTES;
const LEAF_MUTATION: u32 = ANCESTOR_MUTATION
    | FILE_WRITE_DATA_OR_ADD_FILE
    | FILE_APPEND_DATA_OR_ADD_SUBDIR
    | FILE_WRITE_EA;

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0.cast()) };
        }
    }
}

pub(super) fn verify_private_owner_directory(path: &Path) -> io::Result<()> {
    verify_owner_path(path, true)
}

pub(super) fn verify_private_owner_file(path: &Path) -> io::Result<()> {
    verify_owner_path(path, false)
}

fn verify_owner_path(path: &Path, ancestors: bool) -> io::Result<()> {
    if !matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    {
        return Err(unsafe_path(
            "approval storage must be on a local Windows drive",
        ));
    }
    let mut handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(handle);
    let mut bytes = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut bytes) };
    if bytes < size_of::<TOKEN_USER>() as u32 || bytes > 64 * 1024 {
        return Err(unsafe_path("Windows user SID is unavailable"));
    }
    let mut raw = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            raw.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let sid = unsafe { (*raw.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    validate_acl(path, sid, true)?;
    if ancestors {
        for parent in path
            .ancestors()
            .skip(1)
            .filter(|parent| parent.is_absolute())
        {
            validate_acl(parent, sid, false)?;
        }
    }
    Ok(())
}

fn validate_acl(path: &Path, current: PSID, leaf: bool) -> io::Result<()> {
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.contains(&0) {
        return Err(unsafe_path("invalid approval directory path"));
    }
    wide.push(0);
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = Descriptor(null_mut());
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor.0,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if dacl.is_null() || !trusted(owner, current, false) {
        return Err(unsafe_path(
            "approval storage has a shared or untrusted Windows owner/ACL",
        ));
    }
    let count = unsafe { (*dacl).AceCount };
    for index in 0..count {
        let mut raw: *mut c_void = null_mut();
        if unsafe { GetAce(dacl, u32::from(index), &mut raw) } == 0 || raw.is_null() {
            return Err(unsafe_path("cannot validate approval directory ACL"));
        }
        let header = unsafe { *raw.cast::<ACE_HEADER>() };
        if !leaf && header.AceFlags & INHERIT_ONLY != 0 {
            continue;
        }
        if !matches!(header.AceType, 0 | 4 | 5 | 9 | 11) {
            continue;
        }
        if (header.AceSize as usize) < size_of::<ACCESS_ALLOWED_ACE>() {
            return Err(unsafe_path("invalid approval directory ACE"));
        }
        let ace = raw.cast::<ACCESS_ALLOWED_ACE>();
        let mask = unsafe { (*ace).Mask };
        if mask
            & (if leaf {
                LEAF_MUTATION
            } else {
                ANCESTOR_MUTATION
            })
            == 0
        {
            continue;
        }
        if header.AceType != 0 {
            return Err(unsafe_path(
                "approval directory grants an unsupported mutating Windows ACE",
            ));
        }
        let sid = unsafe { addr_of!((*ace).SidStart) }.cast_mut().cast();
        if !trusted(sid, current, header.AceFlags & INHERIT_ONLY != 0) {
            return Err(unsafe_path(
                "approval storage is writable or replaceable by another Windows account",
            ));
        }
    }
    Ok(())
}

fn trusted(sid: PSID, current: PSID, inherit_only: bool) -> bool {
    if sid.is_null() {
        return false;
    }
    unsafe {
        IsValidSid(sid) != 0
            && (EqualSid(sid, current) != 0
                || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                || EqualSid(sid, addr_of!(TRUSTED_INSTALLER).cast_mut().cast()) != 0
                || (inherit_only && IsWellKnownSid(sid, WinCreatorOwnerSid) != 0))
    }
}

fn unsafe_path(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}
