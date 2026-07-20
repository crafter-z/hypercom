# HyperCom 代码签名 & 分发指南

> 生成日期: 2026-07-20 · Phase D.2 of v0.1 roadmap

---

## 现状

- `npm run tauri build` 产出 NSIS 安装器 + MSI（已在 `tauri.conf.json` 配置 NSIS 双语安装）
- **无代码签名** — Windows SmartScreen 会拦截未签名 exe，普通用户直接劝退
- 自动更新已集成 `tauri-plugin-updater`，签名密钥对已生成于 `.tauri/hypercom.key`（**私钥不可提交**，已加入 `.gitignore`）

---

## 签名方案（按优先级）

### 方案 A：Azure Trusted Signing（推荐，免费额度）

微软提供的云签名服务，无需购买证书硬件。

1. 注册 Azure 账号 → 创建 Trusted Signing 资源
2. 安装 `Azure.CodeSigning.Dlib` NuGet 包
3. 在 CI 中配置 `signtool.exe` 调用：
   ```powershell
   signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 `
     /dlib Azure.CodeSigning.Dlib.dll /dmdf azure-signing.json `
     "src-tauri/target/release/bundle/nsis/HyperCom_0.1.0_x64-setup.exe"
   ```
4. Tauri 内置支持：在 `tauri.conf.json` 的 `bundle.windows` 下配置 `signCommand`

### 方案 B：OV/EV 代码签名证书

购买 OV（组织验证）或 EV（扩展验证）证书：

| 供应商 | 类型 | 年费（约） | SmartScreen |
|--------|------|-----------|-------------|
| SSL.com | OV | $100-200 | 需积累信誉 |
| Sectigo | OV | $150-300 | 需积累信誉 |
| DigiCert | EV | $400-600 | 立即通过 |

EV 证书立即获得 SmartScreen 信任，OV 需要下载量积累。

### 方案 C：自签名（仅开发/内测）

```powershell
# 生成自签名证书
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=HyperCom Dev" -KeyAlgorithm RSA -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My"

# 导出 PFX
$password = ConvertTo-SecureString -String "dev-password" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath hypercom-dev.pfx -Password $password

# 签名
signtool sign /f hypercom-dev.pfx /p "dev-password" /fd SHA256 "HyperCom_setup.exe"
```

> ⚠️ 自签名证书不被 Windows 信任，用户需手动"仍要运行"。仅用于内部测试。

---

## Tauri 签名集成

在 `tauri.conf.json` 中配置 `signCommand`（构建时自动签名）：

```json
{
  "bundle": {
    "windows": {
      "signCommand": "signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /f %TAURI_SIGNING_CERTIFICATE% /p %TAURI_SIGNING_CERTIFICATE_PASSWORD% %1"
    }
  }
}
```

CI 中设置环境变量：
- `TAURI_SIGNING_CERTIFICATE`: 证书路径或 base64
- `TAURI_SIGNING_CERTIFICATE_PASSWORD`: 证书密码

---

## 自动更新签名

已生成的密钥对：

| 文件 | 用途 | 位置 |
|------|------|------|
| `.tauri/hypercom.key` | 私钥（签名更新包） | **不可提交**，CI 环境变量注入 |
| `.tauri/hypercom.key.pub` | 公钥（已写入 tauri.conf.json） | 可提交 |

CI 构建更新包时设置：
```bash
export TAURI_SIGNING_PRIVATE_KEY_PATH=".tauri/hypercom.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="hypercom-dev-2026"
npm run tauri build
```

更新 manifest 端点（占位）：`https://releases.hypercom.app/updates/{{target}}/{{arch}}/{{current_version}}`

> 上线前需替换为真实 URL（GitHub Releases / S3 / 自建服务器均可）。

---

## ZIP 便携版（过渡方案）

在正式签名前，提供 ZIP 便携版降低用户门槛：

```powershell
# 构建后打包
Compress-Archive -Path "src-tauri/target/release/hypercom.exe" `
  -DestinationPath "HyperCom-0.1.0-portable-win64.zip"
```

用户解压即用，无 SmartScreen 拦截（ZIP 内的 exe 首次运行仍会提示，但比安装器友好）。

---

## 发版检查清单

- [ ] `npm run tauri build` 成功产出 NSIS + MSI
- [ ] 安装器已签名（方案 A/B/C 之一）
- [ ] 更新包已用 `.tauri/hypercom.key` 签名
- [ ] 更新 manifest JSON 已上传到端点
- [ ] ZIP 便携版已打包
- [ ] 在干净 Windows 10/11 VM 上测试安装 + SmartScreen 行为
- [ ] 版本号已更新（`tauri.conf.json` + `Cargo.toml` + `package.json` 三处一致）