/* ME Snap Stories — core: data layer, feed bar, full-screen viewer, viewers list, management.
   Depends on the globals from index.html: firebase, firebaseApp, firebaseDb, firebaseAuth, setUserAvatar. */
(function () {
    'use strict';

    const DAY = 86400000;
    const PHOTO_MS = 5000;
    const HOLD_MS = 220;
    const db = () => firebaseDb;

    const S = {
        me: null, offset: 0, loaded: false,
        friends: new Set(), blocked: new Set(), friendOff: new Map(),
        idx: new Map(), meta: new Map(), denied: new Set(), fetching: new Set(),
        seen: new Set(), views: {}, profiles: new Map(),
        offs: [], media: new Map(), inflight: new Map(),
        muted: false, v: null, renderQueued: false, expiryTimer: null, sheetRefresh: null
    };

    const now = () => Date.now() + S.offset;
    const isActive = (m) => !!m && typeof m.createdAt === 'number' && now() < m.createdAt + DAY;

    /* ---------- tiny helpers ---------- */
    function h(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function toast(msg) {
        const t = h('div', 's-toast', msg);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3200);
    }
    function ago(ts) {
        const s = Math.max(0, Math.floor((now() - ts) / 1000));
        if (s < 60) return 'Just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        return Math.floor(s / 3600) + 'h ago';
    }
    function expiresIn(ts) {
        const m = Math.max(0, Math.floor((ts + DAY - now()) / 60000));
        return m >= 60 ? Math.floor(m / 60) + 'h left' : m + 'm left';
    }
    function on(target, evt, cb, err) {
        target.on(evt, cb, err || ((e) => console.warn('Stories listener:', e && e.code)));
        return () => target.off(evt, cb);
    }
    function profile(uid) {
        let p = S.profiles.get(uid);
        if (!p) {
            p = { uid, username: '…', photo: '' };
            S.profiles.set(uid, p);
            p.ready = Promise.all([db().ref('users/' + uid + '/username').once('value'), db().ref('users/' + uid + '/profilePhoto').once('value')])
                .then(([a, b]) => { p.username = a.val() || 'User'; p.photo = b.val() || ''; schedule(); if (S.v) updateHeader(); })
                .catch(() => { p.username = 'User'; });
        }
        return p;
    }
    function avatar(img, uid) {
        const p = profile(uid);
        if (typeof setUserAvatar === 'function') setUserAvatar(img, p.photo); else img.src = p.photo || '';
        img.alt = p.username;
    }

    /* ---------- overlays (shared with composer) ---------- */
    function parseOverlays(json) {
        if (!json) return [];
        try {
            const arr = JSON.parse(json);
            if (!Array.isArray(arr)) return [];
            return arr.slice(0, 60).map((o) => {
                if (!o || typeof o !== 'object') return null;
                const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
                if (o.type === 'draw' && Array.isArray(o.points)) {
                    return { type: 'draw', color: String(o.color || '#fff').slice(0, 20), size: Math.min(8, Math.max(.2, n(o.size, 1))), points: o.points.slice(0, 3000).map((p) => [n(p[0], 0), n(p[1], 0)]) };
                }
                if (o.type === 'text' || o.type === 'emoji') {
                    return { type: o.type, text: String(o.text || '').slice(0, 200), color: String(o.color || '#fff').slice(0, 20), x: n(o.x, .5), y: n(o.y, .5), scale: Math.min(60, Math.max(2, n(o.scale, 8))), rot: n(o.rot, 0) };
                }
                return null;
            }).filter(Boolean);
        } catch (e) { return []; }
    }
    function itemEl(o) {
        const e = h('div', 'ov-item', o.text);
        e.style.left = (o.x * 100) + '%';
        e.style.top = (o.y * 100) + '%';
        e.style.fontSize = 'calc(var(--u) * ' + o.scale + ')';
        e.style.transform = 'translate(-50%, -50%) rotate(' + (o.rot || 0) + 'deg)';
        if (o.type === 'text') e.style.color = o.color;
        return e;
    }
    function drawStrokes(canvas, list, w, h2) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h2 * dpr));
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        list.filter((o) => o.type === 'draw').forEach((o) => {
            if (!o.points.length) return;
            ctx.strokeStyle = o.color; ctx.fillStyle = o.color;
            ctx.lineWidth = o.size * (w / 100) * dpr;
            const px = (p) => [p[0] * w * dpr, p[1] * h2 * dpr];
            if (o.points.length === 1) {
                const [x, y] = px(o.points[0]);
                ctx.beginPath(); ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
                return;
            }
            ctx.beginPath();
            o.points.forEach((p, i) => { const [x, y] = px(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
            ctx.stroke();
        });
    }
    function fitStage(panel, stage, ar) {
        const pw = panel.clientWidth, ph = panel.clientHeight;
        if (!pw || !ph || !ar) return;
        let w = pw, hh = pw / ar;
        if (hh > ph) { hh = ph; w = ph * ar; }
        stage.style.width = w + 'px';
        stage.style.height = hh + 'px';
        stage.style.setProperty('--u', (w / 100) + 'px');
        stage._w = w; stage._h = hh;
    }
    function renderOverlays(stage, list) {
        let layer = stage.querySelector(':scope > .ov-layer');
        if (!layer) {
            layer = h('div', 'ov-layer');
            layer.appendChild(h('canvas', 'ov-canvas'));
            stage.appendChild(layer);
        }
        layer.querySelectorAll('.ov-item').forEach((n) => n.remove());
        drawStrokes(layer.querySelector('canvas'), list, stage._w || stage.clientWidth, stage._h || stage.clientHeight);
        list.filter((o) => o.type !== 'draw').forEach((o) => layer.appendChild(itemEl(o)));
        return layer;
    }

    /* ---------- data layer ---------- */
    function schedule() {
        if (S.renderQueued) return;
        S.renderQueued = true;
        requestAnimationFrame(() => { S.renderQueued = false; renderBar(); onFeedChanged(); });
    }
    function addIdx(owner, id, createdAt) {
        if (typeof createdAt !== 'number') return;
        let m = S.idx.get(owner);
        if (!m) { m = new Map(); S.idx.set(owner, m); }
        m.set(id, createdAt);
        fetchMeta(owner, id);
        schedule();
    }
    function removeIdx(owner, id) {
        const m = S.idx.get(owner);
        if (m) { m.delete(id); if (!m.size) S.idx.delete(owner); }
        S.meta.delete(id); S.denied.delete(id); revokeMedia(id);
        schedule();
    }
    function fetchMeta(owner, id) {
        if (S.meta.has(id) || S.denied.has(id) || S.fetching.has(id)) return;
        S.fetching.add(id);
        const me = S.me;
        db().ref('stories/' + owner + '/' + id).once('value').then((sn) => {
            if (S.me !== me) return;
            const v = sn.val();
            const m = S.idx.get(owner);
            if (v && isActive(v) && m && m.has(id)) { v.id = id; v.owner = owner; S.meta.set(id, v); } else S.denied.add(id);
        }).catch((err) => {
            if (err && err.code === 'PERMISSION_DENIED') S.denied.add(id);
            else setTimeout(() => { S.fetching.delete(id); if (S.me === me) fetchMeta(owner, id); }, 5000);
        }).finally(() => { S.fetching.delete(id); schedule(); });
    }
    function attachFriend(fid) {
        if (S.friendOff.has(fid)) return;
        const q = db().ref('storyIndex/' + fid).orderByChild('createdAt').startAt(now() - DAY);
        const o1 = on(q, 'child_added', (sn) => addIdx(fid, sn.key, (sn.val() || {}).createdAt));
        const o2 = on(q, 'child_removed', (sn) => removeIdx(fid, sn.key));
        S.friendOff.set(fid, () => { o1(); o2(); });
    }
    function detachFriend(fid) {
        const off = S.friendOff.get(fid);
        if (off) off();
        S.friendOff.delete(fid);
        const m = S.idx.get(fid);
        if (m) [...m.keys()].forEach((id) => { S.meta.delete(id); S.denied.delete(id); });
        S.idx.delete(fid);
    }
    function syncFriends() {
        const target = new Set([...S.friends].filter((f) => !S.blocked.has(f)));
        [...S.friendOff.keys()].forEach((f) => { if (!target.has(f)) detachFriend(f); });
        target.forEach(attachFriend);
        schedule();
    }

    async function init(user) {
        if (!user || !user.id) return;
        if (S.me === user.id) return;
        teardown();
        S.me = user.id;
        const me = S.me;
        document.body.classList.add('stories-on');
        renderBar();
        try {
            const sn = await Promise.race([db().ref('.info/serverTimeOffset').once('value'), new Promise((r) => setTimeout(r, 2500))]);
            if (sn && typeof sn.val === 'function') S.offset = sn.val() || 0;
        } catch (e) { /* default offset */ }
        if (S.me !== me) return;

        S.offs.push(on(db().ref('users/' + me + '/friends'), 'value', (sn) => { S.friends = new Set(Object.keys(sn.val() || {})); S.loaded = true; syncFriends(); }));
        S.offs.push(on(db().ref('users/' + me + '/blocked'), 'value', (sn) => { S.blocked = new Set(Object.keys(sn.val() || {})); syncFriends(); }));

        const own = db().ref('storyIndex/' + me).orderByChild('createdAt').startAt(now() - DAY);
        S.offs.push(on(own, 'child_added', (sn) => addIdx(me, sn.key, (sn.val() || {}).createdAt)));
        S.offs.push(on(own, 'child_removed', (sn) => removeIdx(me, sn.key)));

        const inbox = db().ref('storyInbox/' + me).orderByChild('createdAt').startAt(now() - DAY);
        S.offs.push(on(inbox, 'child_added', (sn) => { const v = sn.val() || {}; if (v.owner) addIdx(v.owner, sn.key, v.createdAt); }));
        S.offs.push(on(inbox, 'child_removed', (sn) => { const v = sn.val() || {}; if (v.owner) removeIdx(v.owner, sn.key); }));

        S.offs.push(on(db().ref('storySeen/' + me), 'value', (sn) => { S.seen = new Set(Object.keys(sn.val() || {})); schedule(); }));
        S.offs.push(on(db().ref('storyViews/' + me), 'value', (sn) => {
            S.views = sn.val() || {};
            schedule();
            if (S.v) updateOwnUI();
            if (S.sheetRefresh) S.sheetRefresh();
        }));
        cleanupExpired();
        S.cleanupTimer = setInterval(cleanupExpired, 30 * 60000);
    }

    // No scheduled server job exists on the free plan, so each user purges their own expired
    // posts (media, views, index and inbox entries) whenever the app is open.
    async function cleanupExpired() {
        const me = S.me; if (!me) return;
        try {
            const cutoff = now() - DAY;
            const old = await db().ref('storyIndex/' + me).orderByChild('createdAt').endAt(cutoff).limitToFirst(25).once('value');
            const ids = Object.keys(old.val() || {});
            for (const id of ids) {
                if (S.me !== me) return;
                const up = {};
                const st = (await db().ref('stories/' + me + '/' + id).once('value')).val() || {};
                Object.keys(st.audience || {}).forEach((u) => { up['storyInbox/' + u + '/' + id] = null; });
                up['storyMedia/' + me + '/' + id] = null;
                up['storyViews/' + me + '/' + id] = null;
                up['storyIndex/' + me + '/' + id] = null;
                up['stories/' + me + '/' + id] = null;
                up['storySeen/' + me + '/' + id] = null;
                await db().ref().update(up);
            }
            const mine = await db().ref('storyInbox/' + me).orderByChild('createdAt').endAt(cutoff).limitToFirst(50).once('value');
            const stale = {};
            Object.keys(mine.val() || {}).forEach((id) => { stale['storyInbox/' + me + '/' + id] = null; stale['storySeen/' + me + '/' + id] = null; });
            if (Object.keys(stale).length) await db().ref().update(stale);
        } catch (e) { /* retried on the next interval */ }
    }

    function teardown() {
        closeViewer(true);
        document.querySelectorAll('.sv-modal, .cp').forEach((n) => n.remove());
        S.offs.forEach((o) => { try { o(); } catch (e) { /* noop */ } });
        S.offs = [];
        [...S.friendOff.values()].forEach((o) => o());
        S.friendOff.clear();
        clearTimeout(S.expiryTimer); clearInterval(S.cleanupTimer);
        S.me = null; S.loaded = false; S.friends = new Set(); S.blocked = new Set();
        S.idx.clear(); S.meta.clear(); S.denied.clear(); S.fetching.clear(); S.seen = new Set();
        S.views = {}; S.profiles.clear(); clearMediaCache(); S.inflight.clear(); S.sheetRefresh = null;
        if (window.Stories && window.Stories._composerReset) window.Stories._composerReset();
        const bar = document.getElementById('storiesBar');
        if (bar) bar.textContent = '';
    }

    function storiesOf(uid) {
        const m = S.idx.get(uid);
        if (!m) return [];
        return [...m.keys()].map((id) => S.meta.get(id)).filter(isActive).sort((a, b) => a.createdAt - b.createdAt);
    }
    function getFeed() {
        const out = [];
        S.idx.forEach((_, uid) => {
            if (uid === S.me || !S.friends.has(uid) || S.blocked.has(uid)) return;
            const stories = storiesOf(uid);
            if (!stories.length) return;
            out.push({ uid, stories, unseen: stories.some((s) => !S.seen.has(s.id)), latest: stories[stories.length - 1].createdAt, priv: stories.some((s) => s.visibility === 'private') });
        });
        out.sort((a, b) => (a.unseen === b.unseen ? b.latest - a.latest : a.unseen ? -1 : 1));
        return out;
    }
    const viewCount = (id) => Object.keys(S.views[id] || {}).length;
    const firstUnseen = (list) => { const i = list.findIndex((s) => !S.seen.has(s.id)); return i < 0 ? 0 : i; };

    /* ---------- feed bar ---------- */
    function storyItem(uid, ringCls, name, onClick) {
        const b = h('button', 'story-item');
        b.type = 'button';
        const ring = h('div', 'story-ring ' + ringCls);
        const img = h('img');
        avatar(img, uid);
        ring.appendChild(img);
        b.appendChild(ring);
        b.appendChild(h('div', 'story-name', name));
        b.onclick = onClick;
        return { b, ring };
    }
    function renderBar() {
        const bar = document.getElementById('storiesBar');
        if (!bar || !S.me) return;
        const oldRow = bar.querySelector('.stories-row');
        const scroll = oldRow ? oldRow.scrollLeft : 0;
        bar.textContent = '';

        const mine = storiesOf(S.me);
        const title = h('div', 'stories-bar-title');
        title.appendChild(h('span', '', 'Stories'));
        if (mine.length) {
            const mg = h('button', 'story-manage', 'Manage my story');
            mg.type = 'button';
            mg.onclick = openManage;
            title.appendChild(mg);
        }
        bar.appendChild(title);

        const row = h('div', 'stories-row');
        const my = storyItem(S.me, mine.length ? '' : 'none', 'My Story', () => (mine.length ? openViewer(S.me) : openComposer()));
        const plus = h('span', 'story-add', '+');
        plus.title = 'Add to your story';
        plus.onclick = (e) => { e.stopPropagation(); openComposer(); };
        my.ring.appendChild(plus);
        row.appendChild(my.b);

        if (!S.loaded) {
            for (let i = 0; i < 4; i++) row.appendChild(h('div', 'story-skel'));
        } else {
            const feed = getFeed();
            feed.forEach((e) => {
                const it = storyItem(e.uid, (e.unseen ? '' : 'viewed ') + (e.priv ? 'private' : ''), profile(e.uid).username, () => openViewer(e.uid));
                if (!e.unseen) it.b.classList.add('viewed-item');
                it.b.title = e.priv ? 'Private story' : '';
                row.appendChild(it.b);
            });
            if (!feed.length) row.appendChild(h('div', 'stories-empty', 'No friend stories right now'));
        }
        bar.appendChild(row);
        row.scrollLeft = scroll;

        clearTimeout(S.expiryTimer);
        let next = Infinity;
        S.meta.forEach((m) => { if (isActive(m)) next = Math.min(next, m.createdAt + DAY); });
        if (next < Infinity) S.expiryTimer = setTimeout(schedule, Math.min(60000, Math.max(1000, next - now() + 500)));
    }

    /* ---------- media access (chunks stored in the Realtime Database) ---------- */
    const MEDIA_CACHE_MAX = 8;
    function revokeMedia(id) {
        const c = S.media.get(id);
        if (c) { try { URL.revokeObjectURL(c.url); } catch (e) { /* noop */ } S.media.delete(id); }
    }
    function clearMediaCache() { [...S.media.keys()].forEach(revokeMedia); }
    function trimMediaCache(keep) {
        for (const id of [...S.media.keys()]) {
            if (S.media.size <= MEDIA_CACHE_MAX) break;
            if (!keep.includes(id)) revokeMedia(id);
        }
    }
    function b64ToBlob(b64, mime) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }
    function getMediaUrl(st, force) {
        const c = S.media.get(st.id);
        if (!force && c) return Promise.resolve(c.url);
        if (S.inflight.has(st.id) && !force) return S.inflight.get(st.id);
        const n = Number(st.chunks) || 0;
        if (!n) return Promise.reject({ code: 'not-found' });
        const base = 'storyMedia/' + st.owner + '/' + st.id + '/';
        const p = Promise.all(Array.from({ length: n }, (_, i) => db().ref(base + i).once('value')))
            .then((snaps) => {
                const parts = snaps.map((sn) => sn.val());
                if (parts.some((x) => typeof x !== 'string')) throw { code: 'not-found' };
                const url = URL.createObjectURL(b64ToBlob(parts.join(''), st.mime || (st.mediaType === 'video' ? 'video/mp4' : 'image/jpeg')));
                revokeMedia(st.id);
                S.media.set(st.id, { url });
                trimMediaCache([st.id, S.v && S.v.curId]);
                return url;
            })
            .finally(() => S.inflight.delete(st.id));
        S.inflight.set(st.id, p);
        return p;
    }
    const errKind = (e) => {
        const c = (e && e.code) || '';
        if (/not-found|permission[-_]denied/i.test(c)) return 'gone';
        return 'net';
    };

    /* ---------- sheets / modals ---------- */
    function openSheet(build, opts) {
        opts = opts || {};
        const wrap = h('div', 'sv-modal' + (opts.center ? ' center' : ''));
        const sheet = h('div', 'sv-sheet');
        wrap.appendChild(sheet);
        const api = { el: sheet, close() { if (wrap.isConnected) wrap.remove(); if (opts.onClose) opts.onClose(); } };
        wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) api.close(); });
        const onKey = (e) => {
            if (e.key !== 'Escape' || !wrap.isConnected) return;
            const all = document.querySelectorAll('.sv-modal');
            if (all[all.length - 1] !== wrap) return;
            e.stopPropagation();
            api.close();
        };
        document.addEventListener('keydown', onKey, true);
        const baseClose = api.close;
        api.close = () => { document.removeEventListener('keydown', onKey, true); baseClose(); };
        build(sheet, api);
        document.body.appendChild(wrap);
        return api;
    }
    function confirmDialog(title, text, okLabel) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            openSheet((sheet, api) => {
                sheet.appendChild(h('h3', '', title));
                sheet.appendChild(h('p', 'sub', text));
                const acts = h('div', 'row-actions');
                const no = h('button', 's-btn ghost', 'Cancel');
                const yes = h('button', 's-btn danger', okLabel);
                no.onclick = () => { finish(false); api.close(); };
                yes.onclick = () => { finish(true); api.close(); };
                acts.append(no, yes);
                sheet.appendChild(acts);
            }, { center: true, onClose: () => finish(false) });
        });
    }

    /* ---------- own-story actions ---------- */
    function openViewersSheet(st, onClose) {
        openSheet((sheet, api) => {
            const render = () => {
                sheet.textContent = '';
                const entries = Object.entries(S.views[st.id] || {}).sort((a, b) => (b[1] || 0) - (a[1] || 0));
                sheet.appendChild(h('h3', '', entries.length === 1 ? '1 viewer' : entries.length + ' viewers'));
                sheet.appendChild(h('p', 'sub', 'Each person is counted once per post.'));
                if (!entries.length) { sheet.appendChild(h('div', 's-empty', 'No views yet')); return; }
                entries.forEach(([uid, ts]) => {
                    const row = h('div', 's-row');
                    const img = h('img', 'av');
                    avatar(img, uid);
                    const g = h('div', 'grow');
                    g.appendChild(h('b', '', profile(uid).username));
                    g.appendChild(h('span', '', typeof ts === 'number' ? ago(ts) : ''));
                    row.append(img, g);
                    sheet.appendChild(row);
                });
            };
            render();
            S.sheetRefresh = render;
        }, { onClose: () => { S.sheetRefresh = null; if (onClose) onClose(); } });
    }
    async function deleteStory(st) {
        const ok = await confirmDialog('Delete this story?', 'It will be removed immediately for everyone and can’t be restored.', 'Delete');
        if (!ok) return false;
        const up = {};
        up['stories/' + S.me + '/' + st.id] = null;
        up['storyIndex/' + S.me + '/' + st.id] = null;
        up['storyViews/' + S.me + '/' + st.id] = null;
        up['storyMedia/' + S.me + '/' + st.id] = null;
        Object.keys(st.audience || {}).forEach((u) => { up['storyInbox/' + u + '/' + st.id] = null; });
        try {
            await db().ref().update(up);
        } catch (e) {
            toast('Couldn’t delete the story. Check your connection and try again.');
            return false;
        }
        removeIdx(S.me, st.id);
        toast('Story deleted');
        return true;
    }
    async function saveMedia(st) {
        try {
            const url = await getMediaUrl(st);
            const res = await fetch(url);
            if (!res.ok) throw new Error('fetch');
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'mesnap-story-' + st.id + (st.mediaType === 'video' ? (/webm/.test(blob.type) ? '.webm' : '.mp4') : '.jpg');
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        } catch (e) {
            try { window.open(await getMediaUrl(st), '_blank', 'noopener'); } catch (e2) { toast('Couldn’t save this story.'); }
        }
    }

    function openManage() {
        openSheet((sheet, api) => {
            const render = () => {
                sheet.textContent = '';
                const list = storiesOf(S.me).reverse();
                sheet.appendChild(h('h3', '', 'My Story'));
                sheet.appendChild(h('p', 'sub', 'Posts disappear 24 hours after they’re added.'));
                if (!list.length) { sheet.appendChild(h('div', 's-empty', 'You have no active story posts')); return; }
                list.forEach((st) => {
                    const row = h('div', 's-row');
                    const thumb = st.mediaType === 'video' ? h('video', 'thumb') : h('img', 'thumb');
                    if (st.mediaType === 'video') { thumb.muted = true; thumb.preload = 'metadata'; thumb.playsInline = true; }
                    getMediaUrl(st).then((u) => { thumb.src = st.mediaType === 'video' ? u + '#t=0.1' : u; }).catch(() => {});
                    thumb.onclick = () => { api.close(); openViewer(S.me, st.id); };
                    const g = h('div', 'grow');
                    g.appendChild(h('b', '', (st.mediaType === 'video' ? '🎥 Video' : '📷 Photo') + (st.visibility === 'private' ? ' · 🔒 Private' : st.visibility === 'custom' ? ' · Custom' : '')));
                    g.appendChild(h('span', '', ago(st.createdAt) + ' · ' + expiresIn(st.createdAt)));
                    const v = h('button', 'mini', '👁 ' + viewCount(st.id));
                    v.onclick = () => openViewersSheet(st);
                    const sv = h('button', 'mini', '⬇');
                    sv.title = 'Save to device';
                    sv.onclick = () => saveMedia(st);
                    const del = h('button', 'mini danger', '🗑');
                    del.title = 'Delete';
                    del.onclick = () => deleteStory(st);
                    row.append(thumb, g, v, sv, del);
                    sheet.appendChild(row);
                });
            };
            render();
            S.sheetRefresh = render;
        }, { onClose: () => { S.sheetRefresh = null; } });
    }

    async function captureStoryThumbnail(story) {
        if (!story) return '';
        try {
            const url = await getMediaUrl(story);
            if (!url) return '';
            const img = new Image();
            img.decoding = 'async';
            img.src = url;
            await img.decode().catch(() => {});
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(300, img.naturalWidth || 300);
            canvas.height = Math.min(300, img.naturalHeight || 300);
            const ctx = canvas.getContext('2d');
            if (!ctx) return '';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.7);
        } catch (e) {
            return '';
        }
    }

    async function openStoryReply(storyOwnerId, storyId) {
        if (!storyOwnerId || !storyId) return;
        try {
            const snap = await db().ref('stories/' + storyOwnerId + '/' + storyId).once('value');
            const story = snap.val();
            if (!story || !story.createdAt || Date.now() >= story.createdAt + DAY) {
                toast('Story Unavailable');
                return;
            }
            if (typeof window.Stories !== 'undefined' && window.Stories.openViewer) window.Stories.openViewer(storyOwnerId, storyId);
        } catch (e) {
            toast('Story Unavailable');
        }
    }

    async function sendStoryReply(text, story) {
        if (!story || !S.me || story.owner === S.me) return;
        const content = String(text || '').trim();
        if (!content) { toast('Type a message before sending.'); return; }
        const preview = await captureStoryThumbnail(story);
        const payload = {
            senderId: S.me,
            receiverId: story.owner,
            senderName: profile(S.me).username,
            text: content,
            createdAt: Date.now(),
            deliveredAt: firebase.database.ServerValue.TIMESTAMP,
            read: false,
            storyReply: {
                storyId: story.id,
                storyOwnerId: story.owner,
                mediaType: story.mediaType || 'image',
                preview: preview || '',
                sentAt: Date.now()
            }
        };
        const msgRef = db().ref('messages').push();
        await msgRef.set(payload);

        try {
            await db().ref('notifications/' + story.owner).push().set({
                type: 'story_reply',
                senderId: S.me,
                senderName: profile(S.me).username,
                storyId: story.id,
                storyOwnerId: story.owner,
                text: `${profile(S.me).username} replied to your Story: ${content}`,
                message: content,
                createdAt: Date.now(),
                read: false,
                conversationId: [S.me, story.owner].sort().join('_')
            });
        } catch (e) {
            console.warn('Story reply notification failed', e);
        }

        toast('Reply sent');
        if (S.v && S.v.replyInput) {
            S.v.replyInput.value = '';
            S.v.replyInput.blur();
        }
    }

    /* ---------- viewer ---------- */
    function openViewer(uid, startId) {
        if (S.v) closeViewer(true);
        const order = uid === S.me ? [S.me] : getFeed().map((e) => e.uid);
        let qi = order.indexOf(uid);
        if (qi < 0) { order.unshift(uid); qi = 0; }
        const list = storiesOf(uid);
        if (!list.length) return;
        let si = firstUnseen(list);
        if (startId) { const i = list.findIndex((s) => s.id === startId); if (i >= 0) si = i; }
        if (uid === S.me && !startId) si = 0;

        const root = h('div', 'sv');
        root.tabIndex = -1;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', 'Story viewer');
        const panel = h('div', 'sv-panel');
        const backdrop = h('img', 'sv-backdrop');
        backdrop.alt = '';
        const stage = h('div', 'sv-stage');
        const state = h('div', 'sv-state');
        const body = h('div', 'sv-body');
        const top = h('div', 'sv-top');
        const bars = h('div', 'sv-bars');
        const head = h('div', 'sv-head');
        const av = h('img');
        const who = h('div', 'sv-who');
        const nameEl = h('b'); const timeEl = h('span');
        who.append(nameEl, timeEl);
        const mute = h('button', 'sv-iconbtn', '🔊');
        mute.type = 'button'; mute.title = 'Sound'; mute.style.display = 'none';
        const closeBtn = h('button', 'sv-iconbtn', '✕');
        closeBtn.type = 'button'; closeBtn.title = 'Close'; closeBtn.setAttribute('aria-label', 'Close');
        head.append(av, who, mute, closeBtn);
        top.append(bars, head);

        const bottom = h('div', 'sv-bottom');
        const vbtn = h('button', 'sv-viewers-btn');
        vbtn.type = 'button';
        const actions = h('div', 'sv-actions');
        const saveBtn = h('button', 'sv-iconbtn', '⬇'); saveBtn.title = 'Save to device';
        const delBtn = h('button', 'sv-iconbtn', '🗑'); delBtn.title = 'Delete this post';
        actions.append(saveBtn, delBtn);
        bottom.append(vbtn, actions);

        const replyWrap = h('div', 'sv-reply-wrap');
        const replyInput = h('input', 'sv-reply-input');
        replyInput.type = 'text';
        replyInput.placeholder = 'Send a Chat';
        const replyBtn = h('button', 'sv-reply-btn', 'Send');
        replyBtn.type = 'button';
        replyWrap.append(replyInput, replyBtn);
        if (uid === S.me || !S.me) replyWrap.style.display = 'none';
        replyBtn.onclick = async () => {
            const story = S.v && S.v.cur ? S.v.cur : null;
            if (!story) return;
            pause('reply');
            await sendStoryReply(replyInput.value, story);
            resume('reply');
        };
        replyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                replyBtn.click();
            }
        });
        replyInput.addEventListener('focus', () => pause('reply'));
        replyInput.addEventListener('blur', () => resume('reply'));

        panel.append(backdrop, stage, state, body, top, bottom, replyWrap);
        const prevBtn = h('button', 'sv-iconbtn sv-nav', '‹'); prevBtn.style.left = '24px';
        const nextBtn = h('button', 'sv-iconbtn sv-nav', '›'); nextBtn.style.right = '24px';
        root.append(panel, prevBtn, nextBtn);
        document.body.appendChild(root);
        document.body.style.overflow = 'hidden';

        const v = S.v = {
            root, panel, backdrop, stage, state, bars, av, nameEl, timeEl, mute, vbtn, bottom, replyWrap, replyInput, segs: [],
            queue: order, qi, si, token: 0, pauses: new Set(), progress: 0, elapsed: 0, last: 0,
            cur: null, curId: null, media: null, ready: false, ar: 9 / 16, raf: 0, pendingView: null, cleanup: []
        };
        const listen = (t, e, f, o) => { t.addEventListener(e, f, o); v.cleanup.push(() => t.removeEventListener(e, f, o)); };

        const layout = () => { panel.style.width = Math.min(window.innerWidth, window.innerHeight * 9 / 16) + 'px'; fitStage(panel, stage, v.ar); if (v.cur) renderOverlays(stage, parseOverlays(v.cur.overlays)); };
        layout();
        listen(window, 'resize', layout);
        listen(document, 'visibilitychange', () => {
            if (document.hidden) pause('tab');
            else { v.last = 0; resume('tab'); if (v.pendingView) { markViewed(v.pendingView); v.pendingView = null; } }
        });
        listen(window, 'blur', () => pause('blur'));
        listen(window, 'focus', () => { v.last = 0; resume('blur'); });
        listen(window, 'offline', () => { if (v.media && v.media.tagName === 'VIDEO') showSpin(); });
        listen(document, 'keydown', (e) => {
            if (document.querySelector('.sv-modal')) return;
            if (e.key === 'Escape') closeViewer();
            else if (e.key === 'ArrowRight') advance(1);
            else if (e.key === 'ArrowLeft') advance(-1);
            else if (e.key === ' ') { e.preventDefault(); v.pauses.has('key') ? resume('key') : pause('key'); }
        });

        closeBtn.onclick = (e) => { e.stopPropagation(); closeViewer(); };
        prevBtn.onclick = () => advance(-1);
        nextBtn.onclick = () => advance(1);
        mute.onclick = (e) => { e.stopPropagation(); S.muted = !S.muted; if (v.media && v.media.tagName === 'VIDEO') v.media.muted = S.muted; mute.textContent = S.muted ? '🔇' : '🔊'; };
        const sheetWrap = (fn) => { pause('sheet'); fn(() => resume('sheet')); };
        vbtn.onclick = () => v.cur && sheetWrap((done) => openViewersSheet(v.cur, done));
        saveBtn.onclick = () => v.cur && saveMedia(v.cur);
        delBtn.onclick = async () => { if (!v.cur) return; pause('sheet'); await deleteStory(v.cur); resume('sheet'); };

        /* gestures: tap sides, hold to pause, swipe down to close */
        let g = null;
        body.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            g = { x: e.clientX, y: e.clientY, t: Date.now(), held: false, swipe: false, id: e.pointerId, touch: e.pointerType !== 'mouse' };
            body.setPointerCapture(e.pointerId);
            g.timer = setTimeout(() => { g.held = true; pause('hold'); panel.classList.add('holding'); }, HOLD_MS);
        });
        body.addEventListener('pointermove', (e) => {
            if (!g || e.pointerId !== g.id) return;
            const dx = e.clientX - g.x, dy = e.clientY - g.y;
            if (g.touch && !g.swipe && dy > 12 && dy > Math.abs(dx) * 1.2) { g.swipe = true; clearTimeout(g.timer); pause('swipe'); panel.classList.add('dragging'); }
            if (g.swipe) {
                const y = Math.max(0, dy);
                panel.style.transform = 'translateY(' + y + 'px) scale(' + (1 - Math.min(.15, y / 2000)) + ')';
                panel.style.opacity = String(1 - Math.min(.6, y / 600));
            }
        });
        const endGesture = (e, cancelled) => {
            if (!g || e.pointerId !== g.id) return;
            clearTimeout(g.timer);
            const dx = e.clientX - g.x, dy = e.clientY - g.y;
            const was = g; g = null;
            panel.classList.remove('dragging', 'holding');
            if (was.swipe) {
                if (dy > 120 && !cancelled) { closeViewer(); return; }
                panel.style.transform = ''; panel.style.opacity = '';
                resume('swipe');
                return;
            }
            if (was.held) { resume('hold'); return; }
            if (cancelled || Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
            const r = panel.getBoundingClientRect();
            advance(e.clientX < r.left + r.width * 0.33 ? -1 : 1);
        };
        body.addEventListener('pointerup', (e) => endGesture(e, false));
        body.addEventListener('pointercancel', (e) => endGesture(e, true));
        body.addEventListener('contextmenu', (e) => e.preventDefault());

        requestAnimationFrame(() => root.classList.add('open'));
        root.focus();
        v.raf = requestAnimationFrame(tick);
        show();
    }

    function curUid() { const v = S.v; return v.queue[v.qi]; }
    function isVideo() { return S.v && S.v.media && S.v.media.tagName === 'VIDEO'; }
    function showSpin() { const s = S.v.state; s.textContent = ''; s.appendChild(h('div', 'sv-spin')); }
    function clearState() { if (S.v) S.v.state.textContent = ''; }
    function showError(kind) {
        const v = S.v; if (!v) return;
        const s = v.state; s.textContent = '';
        s.appendChild(h('div', '', kind === 'gone' ? 'This story is no longer available' : 'Couldn’t load this story'));
        if (kind !== 'gone') {
            const r = h('button', 's-btn', 'Retry');
            r.onclick = (e) => { e.stopPropagation(); show(true); };
            s.appendChild(r);
            s.appendChild(h('small', '', 'Tap the right side to skip'));
        } else {
            const tk = v.token;
            setTimeout(() => { if (S.v && S.v.token === tk) advance(1); }, 1400);
        }
    }

    function updateHeader() {
        const v = S.v; if (!v || !v.cur) return;
        const p = profile(v.cur.owner);
        avatar(v.av, v.cur.owner);
        v.nameEl.textContent = v.cur.owner === S.me ? 'My Story' : p.username;
        v.timeEl.textContent = ago(v.cur.createdAt) + (v.cur.visibility === 'private' ? ' · 🔒' : '');
        updateOwnUI();
    }
    function updateOwnUI() {
        const v = S.v; if (!v || !v.cur) return;
        const own = v.cur.owner === S.me;
        v.bottom.style.display = own ? 'flex' : 'none';
        if (v.replyWrap) v.replyWrap.style.display = own || !S.me ? 'none' : 'flex';
        if (own) { const n = viewCount(v.cur.id); v.vbtn.textContent = '👁 ' + n + (n === 1 ? ' viewer' : ' viewers'); }
    }
    function buildSegments(n, si) {
        const v = S.v;
        v.bars.textContent = ''; v.segs = [];
        for (let i = 0; i < n; i++) {
            const seg = h('div', 'sv-seg'); const fill = h('i');
            fill.style.transform = 'scaleX(' + (i < si ? 1 : 0) + ')';
            seg.appendChild(fill); v.bars.appendChild(seg); v.segs.push(fill);
        }
    }
    function releaseMedia() {
        const v = S.v;
        if (v.media) {
            if (v.media.tagName === 'VIDEO') { v.media.pause(); v.media.removeAttribute('src'); v.media.load(); }
            v.media.remove();
            v.media = null;
        }
    }

    function show(forceUrl) {
        const v = S.v; if (!v) return;
        const tk = ++v.token;
        releaseMedia();
        const list = storiesOf(curUid());
        const st = list[v.si];
        if (!st) { advance(1); return; }
        v.cur = st; v.curId = st.id; v.ready = false; v.progress = 0; v.elapsed = 0; v.last = 0;
        v.ar = (st.width && st.height) ? st.width / st.height : 9 / 16;
        fitStage(v.panel, v.stage, v.ar);
        v.stage.querySelectorAll('.ov-layer').forEach((n) => n.remove());
        v.backdrop.removeAttribute('src');
        buildSegments(list.length, v.si);
        updateHeader();
        v.mute.style.display = st.mediaType === 'video' ? 'inline-flex' : 'none';
        showSpin();

        getMediaUrl(st, forceUrl).then((url) => {
            if (!S.v || tk !== S.v.token) return;
            mount(st, url, tk);
        }).catch((err) => { if (S.v && tk === S.v.token) showError(errKind(err)); });

        // warm up the next post
        const nxt = list[v.si + 1];
        if (nxt) getMediaUrl(nxt).then((u) => { if (nxt.mediaType === 'image') new Image().src = u; }).catch(() => {});
    }

    function mount(st, url, tk) {
        const v = S.v;
        const ready = () => {
            if (!S.v || tk !== S.v.token || v.ready) return;
            v.ready = true;
            clearState();
            renderOverlays(v.stage, parseOverlays(st.overlays));
            v.last = 0;
            if (document.hidden) v.pendingView = st; else markViewed(st);
        };
        const fail = () => { if (S.v && tk === S.v.token) { releaseMedia(); showError('net'); } };
        if (st.mediaType === 'video') {
            const vd = document.createElement('video');
            vd.playsInline = true; vd.setAttribute('playsinline', ''); vd.preload = 'auto';
            vd.muted = S.muted; vd.controls = false;
            vd.onplaying = () => { clearState(); ready(); };
            vd.onwaiting = () => { if (!v.pauses.size) showSpin(); };
            vd.onstalled = vd.onwaiting;
            vd.onended = () => { if (S.v && tk === S.v.token) advance(1); };
            vd.onerror = fail;
            vd.src = url;
            v.media = vd;
            v.stage.prepend(vd);
            if (!v.pauses.size) {
                const p = vd.play();
                if (p && p.catch) p.catch(() => { vd.muted = true; S.muted = true; v.mute.textContent = '🔇'; vd.play().catch(fail); });
            }
        } else {
            const img = new Image();
            img.alt = ''; img.draggable = false; img.decoding = 'async';
            img.onload = () => { v.backdrop.src = url; ready(); };
            img.onerror = fail;
            img.src = url;
            v.media = img;
            v.stage.prepend(img);
        }
    }

    function markViewed(st) {
        if (!st || st.owner === S.me || S.seen.has(st.id)) return;
        S.seen.add(st.id);
        db().ref('storyViews/' + st.owner + '/' + st.id + '/' + S.me).set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
        db().ref('storySeen/' + S.me + '/' + st.id).set(true).catch(() => {});
        schedule();
    }

    function pause(reason) {
        const v = S.v; if (!v) return;
        v.pauses.add(reason);
        if (isVideo()) v.media.pause();
    }
    function resume(reason) {
        const v = S.v; if (!v) return;
        v.pauses.delete(reason);
        if (!v.pauses.size && isVideo()) {
            const p = v.media.play();
            if (p && p.catch) p.catch(() => {});
        }
    }

    function tick(ts) {
        const v = S.v; if (!v) return;
        v.raf = requestAnimationFrame(tick);
        const dt = v.last ? Math.min(ts - v.last, 100) : 0;
        v.last = ts;
        if (!v.cur) return;
        if (!isActive(v.cur)) { v.cur = null; show(); return; }
        let p = v.progress;
        if (isVideo()) {
            const vd = v.media;
            const d = isFinite(vd.duration) && vd.duration > 0 ? vd.duration : (v.cur.duration || 0);
            if (v.ready && d > 0) p = Math.min(1, vd.currentTime / d);
        } else if (v.ready && !v.pauses.size) {
            v.elapsed += dt;
            p = v.elapsed / PHOTO_MS;
        }
        v.progress = Math.min(1, p);
        const fill = v.segs[v.si];
        if (fill) fill.style.transform = 'scaleX(' + v.progress + ')';
        if (!isVideo() && v.ready && p >= 1) advance(1);
    }

    function advance(dir) {
        const v = S.v; if (!v) return;
        if (dir > 0) {
            const list = storiesOf(curUid());
            if (v.si + 1 < list.length) { v.si++; show(); return; }
            for (let q = v.qi + 1; q < v.queue.length; q++) {
                const l = storiesOf(v.queue[q]);
                if (l.length) { v.qi = q; v.si = firstUnseen(l); show(); return; }
            }
            closeViewer();
        } else {
            if (v.si > 0) { v.si--; show(); return; }
            for (let q = v.qi - 1; q >= 0; q--) {
                const l = storiesOf(v.queue[q]);
                if (l.length) { v.qi = q; v.si = l.length - 1; show(); return; }
            }
            show();
        }
    }

    // Keeps the viewer consistent when stories are deleted, expire or arrive while it is open.
    function onFeedChanged() {
        const v = S.v; if (!v || !v.curId) return;
        const list = storiesOf(curUid());
        const i = list.findIndex((s) => s.id === v.curId);
        if (i >= 0) {
            if (i !== v.si || list.length !== v.segs.length) {
                v.si = i;
                buildSegments(list.length, i);
            }
            updateHeader();
            return;
        }
        if (v.si < list.length) { show(); return; }
        v.cur = null; v.curId = null;
        advance(1);
    }

    function closeViewer(silent) {
        const v = S.v; if (!v) return;
        cancelAnimationFrame(v.raf);
        v.token++;
        releaseMedia();
        v.cleanup.forEach((f) => f());
        S.v = null;
        document.body.style.overflow = '';
        document.querySelectorAll('.sv-modal').forEach((n) => n.remove());
        S.sheetRefresh = null;
        if (silent) { v.root.remove(); return; }
        v.root.classList.remove('open');
        setTimeout(() => v.root.remove(), 200);
        schedule();
    }

    function openComposer(opts) {
        if (!S.me) return;
        if (window.Stories && window.Stories._openComposer) window.Stories._openComposer(opts);
        else toast('Stories camera is still loading…');
    }

    window.Stories = {
        init, teardown, openViewer, openManage, openComposer, close: closeViewer,
        _: { S, h, toast, now, DAY, db, fitStage, renderOverlays, drawStrokes, itemEl, parseOverlays, openSheet, confirmDialog, profile, avatar, getFeed, storiesOf }
    };

    // index.html may have finished login before this script loaded.
    if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) init(currentUser);

    if (typeof firebaseAuth !== 'undefined') {
        firebaseAuth.onAuthStateChanged((u) => { if (!u && S.me) teardown(); });
    }
})();
