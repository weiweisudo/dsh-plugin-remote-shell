# Windows 二进制签名

未签名 exe 的问题不是“不能运行”，而是：

- SmartScreen 首次下载提示“未知发布者”
- Defender 可能误报
- 企业环境可能直接拦截
- 用户无法验证发布者

## 方案对比

| 方案 | 成本 | 适合 | 能解决 SmartScreen 吗 |
|---|---|---|---|
| 自签名证书 | 免费 | 内部测试 | ❌ 仍然提示未知发布者 |
| **SignPath.io OSS** | 免费（开源项目） | 开源项目 | 部分，需积累信誉 |
| **Azure Trusted Signing** | 约 $9.99/月 | 有组织/历史的主体 | 部分，需积累信誉 |
| **Certum Open Source** | 几十欧/年 | 个人开源项目 | 部分 |
| EV Code Signing | 较贵 | 商业分发 | 较快建立信誉 |
| 不签名 + SHA256 | 免费 | 技术用户/自用 | ❌ |

**签名不等于立刻没有 SmartScreen**。证书只证明发布者身份；信誉需要下载量积累。EV 证书建立信誉最快。

## 推荐路径

### 路线 A：先不签，内部/技术用户使用

- 发布 SHA256
- 提供 GitHub Actions 构建来源
- README 说明“未签名，SmartScreen 可能提示”
- 适合当前 P0/P0.5 阶段

### 路线 B：开源免费签名（推荐下一步）

**SignPath.io** 对开源项目提供免费代码签名：

1. 申请 SignPath OSS 项目
2. 安装 SignPath GitHub App
3. 在 release workflow 中调用 SignPath action
4. 私钥在 SignPath 云端，不进仓库
5. 产物签名后再上传 Release

优点：免费、CI 集成、无需买硬件 token。
缺点：需要审核；签名后仍需积累 SmartScreen 信誉。

### 路线 C：Azure Trusted Signing

适合有公司/组织主体：

1. Azure 订阅
2. 创建 Trusted Signing Account + Certificate Profile
3. GitHub Actions 用 OIDC 登录 Azure
4. `azure/trusted-signing-action` 签名
5. 时间戳服务

优点：云端密钥、CI 友好、微软生态。
缺点：需要付费和身份审核；个人开发者可能不满足历史要求。

### 路线 D：Certum Open Source

适合个人开源项目：

- 申请 Certum Open Source Code Signing
- 私钥在云签名服务或硬件 token
- 本地/CI 用 `signtool` 签名

优点：比 EV 便宜，开源可申请。
缺点：需要身份材料；CI 配置比 SignPath 麻烦。

## 不要做

- 不要把 PFX/私钥提交到仓库
- 不要用自签名证书冒充“已签名”
- 不要在 CI 日志打印证书密码
- 不要用网上来路不明的证书

## 签名命令

如果拿到标准代码签名证书：

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f cert.pfx /p $env:CERT_PASSWORD `
  remote-agent-windows-amd64.exe
```

验证：

```powershell
signtool verify /pa /v remote-agent-windows-amd64.exe
Get-AuthenticodeSignature .\remote-agent-windows-amd64.exe
```

## GitHub Actions 集成思路

```yaml
- name: Sign Windows binary
  if: runner.os == 'Windows'
  run: |
    signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
      /f $env:CERT_PATH /p $env:CERT_PASSWORD `
      dist/remote-agent-windows-amd64.exe
  env:
    CERT_PATH: ${{ secrets.WINDOWS_CERT_PATH }}
    CERT_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
```

更推荐用 SignPath / Trusted Signing 的官方 action，避免把证书放进 GitHub Secrets。

## 当前建议

1. 现在继续发未签名版，标注 SHA256 和“未签名”
2. 完成 Windows 实机验收
3. 加 LICENSE
4. 申请 SignPath OSS
5. 签名后再做社区推广
