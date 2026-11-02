// ==========================================================================
// Push to a person's phones, through Firebase Cloud Messaging (free, no limit).
//
// Every phone the person registered (assets/pa-push.js) has a doc in
// users/{uid}/devices with its fcmToken. A token Google says is dead is
// deleted, so one lost phone does not cost a failed send forever. Only the
// two codes that mean the TOKEN is bad: 'invalid-argument' can be a fault in
// the message itself, and deleting a good phone for that silently ended its
// alerts until the operator turned them on again.
// ==========================================================================

const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

/**
 * Send one message to every registered phone of each uid.
 * deps: { db, sendPush(token, payload) -> Promise, appUrl, log }
 * msg:  { title, body, tag?, url?, ttlSec? }
 * Resolves the number of phones reached.
 */
export async function notify(deps, uids, msg) {
  const { db, sendPush, appUrl, log } = deps;
  let sent = 0;
  for (const uid of [...new Set(uids)].filter(Boolean)) {
    const snap = await db.collection('users/' + uid + '/devices').get();
    for (const d of snap.docs) {
      const dev = d.data();
      if (!dev.fcmToken) continue;
      try {
        // Cloud Messaging data values must all be strings. ttlSec: how long the
        // push service may hold it for a phone that is offline (sendPush's default otherwise).
        const p = { title: String(msg.title || 'Paddle App'), body: String(msg.body || ''),
                    url: String(msg.url || appUrl), tag: String(msg.tag || 'pa') };
        if (msg.ttlSec) p.ttlSec = msg.ttlSec;
        await sendPush(dev.fcmToken, p);
        sent++;
      } catch (e) {
        const code = e && (e.code || (e.errorInfo && e.errorInfo.code));
        if (DEAD_TOKEN.has(code)) {
          await d.ref.delete().catch(() => {});
          // Logged: an iPhone that cancels its own subscription shows up here.
          if (log && log.warn) log.warn('phone dropped', { uid, device: d.id, platform: String(dev.platform || '').slice(0, 60), code });
        }
        else if (log) log.error('push failed', { uid, code: code || String(e) });
      }
    }
  }
  return sent;
}
