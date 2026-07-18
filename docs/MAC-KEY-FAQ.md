# macOS 微信密钥自动获取失败排障指南

WeFlow 当前内置的 macOS 密钥工具尚未适配微信 4.1.11 及更新版本。这里只影响“自动获取密钥”；已经配置好密钥的用户仍可正常使用聊天查看、分析与导出等功能。

## 推荐处理方式

不需要重启 Mac，也不要连续点击“自动获取密钥”。请按下面的顺序操作：

1. 使用 `Command + Q` 完全退出微信。
2. 从 [wechat-versions 的 4.1.8.100 固定版本页面](https://github.com/canc3s/wechat-versions/releases/tag/v4.1.8.100-mac) 下载并安装微信 4.1.8.100。
3. 重新打开微信并登录账号，至少打开一个普通聊天。
4. 回到 WeFlow，只尝试一次“自动获取密钥”。
5. 获取成功后可以继续使用 WeFlow；如有需要，也可以再把微信升级到日常使用的版本。

固定版本安装包：

<https://github.com/canc3s/wechat-versions/releases/download/v4.1.8.100-mac/WeChatMac_4.1.8.dmg>

SHA256：

```text
f40488335cd64422b7a4e144595da0b33cbc64ea8809278871a98b2de5dfed67
```

下载完成后可以在终端校验：

```sh
shasum -a 256 ~/Downloads/WeChatMac_4.1.8.dmg
```

请优先使用上面的 GitHub Release 固定资源。腾讯 CDN 的 `WeChatMac_4.1.8.dmg` 地址会被后续 4.1.8 小版本覆盖，不能长期保证下载到 4.1.8.100，也不能继续使用上面的 SHA256 校验值。

## 常见报错

### `SCAN_FAILED: Sink pattern not found`

当前微信版本的目标函数特征尚未被 WeFlow 识别。微信 4.1.11 已确认会触发这一错误，请直接使用上面的 4.1.8.100 固定版本，无需重启 Mac。

### `SCAN_FAILED: No suitable module found`

先确认微信已经完整启动并保持在前台。如果仍然失败，请完全退出微信，安装 4.1.8.100，再重新打开微信并尝试一次。

### `patch_breakpoint_failed` 或 `thread_get_state_failed`

系统拒绝了调试断点或线程状态读取。请停止连续重试，确认使用的是打包后的 WeFlow.app，然后完全退出并重新打开微信。重启 Mac 不是必要步骤。

### `task_for_pid:5`

系统拒绝了进程附加权限。请确认使用的是打包后的 WeFlow.app，并允许弹出的管理员授权。该错误属于权限问题，不要通过反复点击来解决。

## 关于 r266-tech/wechat-cli

`r266-tech/wechat-cli` 与 WeFlow 使用的是不同的密钥读取和数据库访问实现。其最新版已经提供针对微信 4.1.10+ 的 PBKDF fallback，因此不能据此判断 WeFlow 也已经兼容微信 4.1.11；本页描述的是 WeFlow 当前内置 helper 的实际兼容范围。

如果仍然失败，请保留完整报错文本，特别是 `SCAN_FAILED` 或 `HOOK_FAILED` 后面的英文细节，并提交到 [WeFlow issue](https://github.com/makerjackie/WeFlow/issues)。不要在 issue 中上传数据库、密钥或聊天内容。
