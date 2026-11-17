// lib/notify.mjs — 迁移结束时的系统通知（尽力而为，失败静默）。
// 小白不会盯着终端，跑完得让他知道。

import { execFile } from 'node:child_process'
import { platform } from 'node:os'

export function notify({ title = 'DSH 迁移', message = '' } = {}) {
  const os = platform()
  const run = (cmd, args) => new Promise((resolve) => {
    try { execFile(cmd, args, () => resolve(true)) } catch { resolve(false) }
  })
  if (os === 'darwin') {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
    return run('osascript', ['-e', script])
  }
  if (os === 'linux') return run('notify-send', [title, message])
  if (os === 'win32') {
    const ps = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms');[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`
    return new Promise((resolve) => {
      try {
        execFile('powershell', ['-NoProfile', '-Command', ps], () => resolve(true))
      } catch { resolve(false) }
    })
  }
  return Promise.resolve(false)
}
