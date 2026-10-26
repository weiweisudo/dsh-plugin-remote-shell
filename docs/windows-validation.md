# Windows 实机验证清单

版本：`v0.1.0-p0.5.9`

## 1. 启动形态

- [ ] 双击 exe 不出现控制台窗口
- [ ] 托盘出现桔子图标
- [ ] 托盘菜单：打开设置 / 重连 / 开机启动 / 安装服务 / 解除服务 / 退出
- [ ] 关闭设置页/浏览器后，托盘仍运行

## 2. 本地设置页

- [ ] 端口在 49777–49796 或临时端口
- [ ] 只监听 127.0.0.1
- [ ] 状态显示在线/离线、machine id、凭证到期
- [ ] 能粘贴配对链接并连接

## 3. 开机启动

- [ ] 打开开关后：

```powershell
reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v DSHRemoteShell
```

- [ ] 注销/重启后托盘自动出现
- [ ] 关闭开关后注册表值消失
- [ ] 服务运行时开关禁用

## 4. 服务

- [ ] 管理员执行 `remote-agent.exe service install`
- [ ] `sc query dsh-remote-shell` 显示 RUNNING
- [ ] 服务模式下无托盘/无窗口
- [ ] `service uninstall` 后服务删除
- [ ] 服务 + 托盘不会重复连接

## 5. 一次性执行

```text
juzi_hosts
juzi_exec(machine, shell="powershell", command="$x = 'abc'; $x")
juzi_exec(machine, shell="powershell", command="[Console]::OutputEncoding=[Text.Encoding]::UTF8; '中文UTF8测试'")
```

- [ ] 双引号命令不报 CommandNotFound
- [ ] 中文不乱码
- [ ] 子进程不弹窗
- [ ] exit code / stderr 正确

## 6. 持久会话

```text
juzi_session_open(machine, shell="powershell")
juzi_session_exec(session_id, command="cd C:\\")
juzi_session_exec(session_id, command="(Get-Location).Path")
juzi_session_close(session_id)
```

- [ ] cwd 跨命令保留
- [ ] 变量跨命令保留
- [ ] 超时行为符合文档（销毁会话）
- [ ] close 后进程退出

## 7. 异步 job

```text
juzi_job_start(machine, shell="powershell", command="Start-Sleep 10; 'done'")
juzi_job_status(job_id, wait_ms=30000)
juzi_job_cancel(job_id)
```

- [ ] start 1 秒内返回 job_id
- [ ] status 能看到 running/耗时/字节数
- [ ] 完成后 exited + 输出尾部
- [ ] cancel 杀进程树
- [ ] Web「任务」卡片显示并取消
- [ ] agent 断线重连后 job_list 能看到任务

## 8. 待办

- [ ] 异步 job：长任务不占同步调用
- [ ] DPAPI 保存凭证
- [ ] 代码签名
