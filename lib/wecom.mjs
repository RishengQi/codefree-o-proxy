// 企业微信群机器人 webhook 客户端（无外部依赖，等价于官方 SDK 的最小实现）。
// 协议：POST <webhookUrl>，body 为 {msgtype:"text"|"markdown", text|markdown:{content}}；
// 企微即使业务失败也返回 HTTP 200，需要检查响应体 errcode。

const TEXT_MAX_BYTES = 2048;
const MARKDOWN_MAX_BYTES = 4096;

/** 按 UTF-8 字节数截断，避免企微 2048/4096 字节限制导致整条消息被拒。 */
export function truncateBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const suffix = '\n…(消息已截断)';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > budget) break;
    out += ch;
    bytes += b;
  }
  return out + suffix;
}

export class WeComWebhook {
  constructor({
    url = '',
    msgType = 'text',
    mentionedList = [],
    mentionedMobileList = [],
    timeoutMs = 10000,
    logger,
  } = {}) {
    const raw = String(url || '').trim();
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch {}
    // 只允许 http/https，拒绝 file:/gopher:/data: 等协议，降低误配置导致的 SSRF 风险
    this.url = parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? raw : '';
    if (raw && !this.url) logger?.warn('企微 webhook URL 协议不受支持（仅 http/https）');
    this.msgType = msgType === 'markdown' ? 'markdown' : 'text';
    this.mentionedList = Array.isArray(mentionedList) ? mentionedList.filter(Boolean).map(String) : [];
    this.mentionedMobileList = Array.isArray(mentionedMobileList)
      ? mentionedMobileList.filter(Boolean).map(String)
      : [];
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 10000);
    this.logger = logger;
  }

  get enabled() {
    return Boolean(this.url);
  }

  /**
   * 发送一条消息。
   * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, errcode?:number|null, errmsg?:string|null, error?:string}>}
   */
  async send(content) {
    if (!this.enabled || !content) return { ok: false, skipped: true };
    const text = truncateBytes(
      String(content),
      this.msgType === 'markdown' ? MARKDOWN_MAX_BYTES : TEXT_MAX_BYTES,
    );
    const payload =
      this.msgType === 'markdown'
        ? { msgtype: 'markdown', markdown: { content: text } }
        : {
            msgtype: 'text',
            text: {
              content: text,
              ...(this.mentionedList.length ? { mentioned_list: this.mentionedList } : {}),
              ...(this.mentionedMobileList.length ? { mentioned_mobile_list: this.mentionedMobileList } : {}),
            },
          };
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      let body = null;
      let parsed = false;
      try {
        body = await res.json();
        parsed = true;
      } catch {}
      const rawErrcode = body?.errcode;
      const errcode =
        typeof rawErrcode === 'number'
          ? rawErrcode
          : typeof rawErrcode === 'string' && /^-?\d+$/.test(rawErrcode.trim())
            ? Number(rawErrcode.trim())
            : null;
      const errmsg = body && typeof body.errmsg === 'string' ? body.errmsg : null;
      // 企微业务失败也返回 HTTP 200；非 JSON/缺少 errcode 同样视为失败，避免静默丢告警
      if (!res.ok || !parsed || errcode === null || errcode !== 0) {
        this.logger?.warn('企微告警 webhook 返回异常', { status: res.status, errcode, errmsg, parsed });
        return { ok: false, status: res.status, errcode, errmsg };
      }
      return { ok: true, status: res.status, errcode, errmsg };
    } catch (e) {
      this.logger?.warn('企微告警 webhook 发送失败', { error: String(e?.message || e) });
      return { ok: false, error: String(e?.message || e) };
    }
  }
}
