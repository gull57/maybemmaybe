/* ME Snap Stories — composer: camera/upload, editor (text, emoji, drawing), privacy, compression, upload with retry. */
(function () {
    'use strict';
    if (!window.Stories) return;
    const { S, h, toast, now, db, fitStage, renderOverlays, drawStrokes, openSheet, confirmDialog, profile, avatar } = window.Stories._;

    const MAX_DRAFTS = 10;
    const MAX_IMAGE_RAW = 30 * 1024 * 1024;
    const MAX_VIDEO = 6 * 1024 * 1024;
    const MAX_IMAGE_OUT = 900 * 1024;
    const CHUNK = 250000;
    const MAX_CHUNKS = 40;
    const MAX_VIDEO_SEC = 30;
    const MAX_RECORD_SEC = 15;
    const MAX_DIM = 1280;
    const COLORS = ['#ffffff', '#000000', '#FFFC00', '#F23C57', '#0CB0FF', '#00FF66', '#ff8a00', '#c26bff'];
    const EMOJIS = '😀 😂 🥹 😍 😎 🤩 🥳 😭 😡 🤔 🙄 😴 🤯 😈 👻 💀 👍 👏 🙌 🙏 💪 ✌️ 🤞 👀 ❤️ 🔥 ✨ 💯 🎉 🎂 🍕 🍔 🍟 🍿 ☕ 🍺 ⚽ 🏀 🎮 🎧 🚗 ✈️ 🏖️ 🌈 ☀️ 🌙 ⭐ 🐶 🐱 🦄 🐸 🌸 🍀 💩 🫶 💖 💔 📸 🎬 📍 ⏰'.split(' ');

    let C = null;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const baseType = (t) => String(t || '').split(';')[0].trim().toLowerCase();
    const typeFromName = (n) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[String(n).split('.').pop().toLowerCase()] || '');
    const newId = () => db().ref('stories/' + S.me).push().key;

    function open(opts) {
        if (C) return;
        const me = S.me;
        C = {
            me, drafts: [], cur: -1, tool: null, color: COLORS[0], brush: 1.2, sel: -1, view: 'picker',
            vis: localStorage.getItem('mesnap_story_vis') || 'friends', audience: new Set(), excluded: new Set(),
            posting: false, cam: null, observers: [], lastPostAt: 0
        };
        if (!['friends', 'custom', 'private'].includes(C.vis) || C.vis === 'private') C.vis = 'friends';
        db().ref('storySettings/' + me + '/excluded').once('value').then((sn) => { if (C) C.excluded = new Set(Object.keys(sn.val() || {})); }).catch(() => {});

        const root = h('div', 'cp');
        const head = h('div', 'cp-head');
        const closeBtn = h('button', 'sv-iconbtn', '✕');
        closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', 'Close');
        const title = h('h3', '', 'New story');
        head.append(closeBtn, title, h('span'));
        head.lastChild.style.width = '38px';
        const main = h('div', 'cp-main');
        const foot = h('div', 'cp-foot');
        root.append(head, main, foot);
        document.body.appendChild(root);
        document.body.style.overflow = 'hidden';
        Object.assign(C, { root, head, title, main, foot });

        closeBtn.onclick = requestClose;
        C.onKey = (e) => {
            if (document.querySelector('.sv-modal') || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            if (e.key === 'Escape') requestClose();
            if ((e.key === 'Delete' || e.key === 'Backspace') && C.view === 'edit' && C.sel >= 0) { e.preventDefault(); removeItem(C.sel); }
        };
        document.addEventListener('keydown', C.onKey);
        root.addEventListener('dragover', (e) => e.preventDefault());
        root.addEventListener('drop', (e) => { e.preventDefault(); if (!C.posting && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

        setView('picker');
        if (opts && opts.files) addFiles(opts.files);
    }

    async function requestClose() {
        if (!C) return;
        if (C.posting) {
            const ok = await confirmDialog('Cancel upload?', 'Posts still uploading will be discarded.', 'Cancel upload');
            if (!ok) return;
        } else if (C.drafts.length && C.view !== 'post') {
            const ok = await confirmDialog('Discard story?', 'Your edits will be lost.', 'Discard');
            if (!ok) return;
        }
        close();
    }
    // Remove chunks of a draft that was uploaded but never published.
    function dropUploaded(d) {
        if (d.uploaded && !d.published && C) db().ref('storyMedia/' + C.me + '/' + d.id).remove().catch(() => {});
    }
    function close() {
        if (!C) return;
        stopCamera();
        C.drafts.forEach((d) => { if (d.task) try { d.task.cancel(); } catch (e) { /* noop */ } dropUploaded(d); URL.revokeObjectURL(d.url); });
        C.observers.forEach((o) => o.disconnect());
        document.removeEventListener('keydown', C.onKey);
        C.root.remove();
        document.body.style.overflow = S.v ? 'hidden' : '';
        C = null;
    }

    /* ---------- views ---------- */
    function setView(v) {
        C.view = v;
        C.observers.forEach((o) => o.disconnect()); C.observers = [];
        C.main.textContent = ''; C.foot.textContent = '';
        C.title.textContent = v === 'post' ? 'Posting' : v === 'cam' ? 'Camera' : 'New story';
        if (v === 'picker') viewPicker();
        else if (v === 'cam') viewCamera();
        else if (v === 'edit') viewEditor();
        else viewPosting();
    }

    function viewPicker() {
        stopCamera();
        const wrap = h('div', 'cp-picker');
        if (C.drafts.length) {
            const back = h('button', 'big', '← Back to editing');
            back.onclick = () => setView('edit');
            wrap.appendChild(back);
        }
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const cam = h('button', 'big primary', '📷  Open camera');
            cam.onclick = () => setView('cam');
            wrap.appendChild(cam);
        }
        const up = h('button', 'big', '🖼️  Upload photos or videos');
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime,image/*,video/*'; input.multiple = true; input.hidden = true;
        input.onchange = () => { addFiles([...input.files]); input.value = ''; };
        up.onclick = () => input.click();
        wrap.append(up, input, h('small', '', 'Photos: JPG, PNG, WebP. Videos: MP4, WebM, MOV up to 30 seconds and 6 MB. You can also drop files here.'));
        C.main.appendChild(wrap);
    }

    /* ---------- camera ---------- */
    async function startStream() {
        stopStream();
        const video = { facingMode: C.cam.facing, width: { ideal: 1080 }, height: { ideal: 1920 } };
        try { C.cam.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true }); C.cam.audio = true; }
        catch (e) {
            C.cam.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
            C.cam.audio = false;
        }
        if (!C || !C.cam) { stopStream(); return; }
        C.cam.video.srcObject = C.cam.stream;
        C.cam.video.style.transform = C.cam.facing === 'user' ? 'scaleX(-1)' : '';
        C.cam.video.play().catch(() => {});
    }
    function stopStream() { if (C && C.cam && C.cam.stream) { C.cam.stream.getTracks().forEach((t) => t.stop()); C.cam.stream = null; } }
    function stopCamera() {
        if (!C || !C.cam) return;
        if (C.cam.rec && C.cam.rec.state !== 'inactive') { C.cam.discard = true; try { C.cam.rec.stop(); } catch (e) { /* noop */ } }
        clearInterval(C.cam.timer);
        stopStream();
        C.cam = null;
    }
    function viewCamera() {
        const box = h('div', 'cp-cam');
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
        const wrap = h('div', 'shutter-wrap');
        const flip = h('button', 'sv-iconbtn', '🔄'); flip.title = 'Flip camera';
        const shutter = h('button', 'cp-shutter'); shutter.setAttribute('aria-label', 'Tap for photo, hold for video');
        const back = h('button', 'sv-iconbtn', '✕'); back.title = 'Back';
        wrap.append(back, shutter, flip);
        const hint = h('div', 'cp-hint', 'Tap for photo · Hold for video');
        box.append(video, hint, wrap);
        C.main.appendChild(box);
        C.cam = { video, facing: 'user', stream: null, rec: null, timer: 0 };

        back.onclick = () => setView(C.drafts.length ? 'edit' : 'picker');
        flip.onclick = () => { C.cam.facing = C.cam.facing === 'user' ? 'environment' : 'user'; startStream().catch(camError); };
        startStream().catch(camError);

        let down = 0, holdTimer = 0, recording = false;
        const startRec = () => {
            const cam = C.cam;
            if (!cam || !cam.stream || typeof MediaRecorder === 'undefined') { toast('Video recording isn’t supported here — tap for a photo.'); return; }
            const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
            const chunks = [];
            let rec;
            try { rec = new MediaRecorder(cam.stream, Object.assign({ videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 }, mime ? { mimeType: mime } : {})); }
            catch (e) { toast('Couldn’t start recording.'); return; }
            cam.rec = rec; recording = true; cam.discard = false;
            const t0 = Date.now();
            rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            rec.onstop = () => {
                clearInterval(cam.timer);
                const secs = (Date.now() - t0) / 1000;
                if (cam.discard || !C) return;
                const type = baseType(rec.mimeType || mime || 'video/webm');
                const file = new File(chunks, 'camera.' + (type === 'video/mp4' ? 'mp4' : 'webm'), { type });
                addFiles([file], { duration: secs, fromCamera: true });
            };
            rec.start(1000);
            shutter.classList.add('rec'); hint.style.display = 'none';
            const tag = h('div', 'cp-rec-time', '● 0:00');
            box.appendChild(tag);
            cam.timer = setInterval(() => {
                const s = Math.floor((Date.now() - t0) / 1000);
                tag.textContent = '● 0:' + String(s).padStart(2, '0');
                if (s >= MAX_RECORD_SEC) stopRec();
            }, 250);
            cam.tag = tag;
        };
        const stopRec = () => {
            if (C && C.cam && C.cam.rec && C.cam.rec.state === 'recording') C.cam.rec.stop();
            recording = false;
        };
        const photo = () => {
            const v = C.cam && C.cam.video;
            if (!v || !v.videoWidth) return;
            const cv = document.createElement('canvas');
            cv.width = v.videoWidth; cv.height = v.videoHeight;
            cv.getContext('2d').drawImage(v, 0, 0);
            cv.toBlob((b) => { if (b && C) addFiles([new File([b], 'camera.jpg', { type: 'image/jpeg' })], { fromCamera: true }); }, 'image/jpeg', 0.92);
        };
        shutter.addEventListener('pointerdown', (e) => { shutter.setPointerCapture(e.pointerId); down = Date.now(); holdTimer = setTimeout(startRec, 350); });
        shutter.addEventListener('pointerup', () => { clearTimeout(holdTimer); if (recording) stopRec(); else if (Date.now() - down < 350) photo(); });
        shutter.addEventListener('pointercancel', () => { clearTimeout(holdTimer); if (recording) stopRec(); });
    }
    function camError(e) {
        const msg = e && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow access in your browser settings, or upload a file instead.' : 'No camera is available. You can upload a file instead.';
        toast(msg);
        if (C && C.view === 'cam') setView(C.drafts.length ? 'edit' : 'picker');
    }

    /* ---------- adding media ---------- */
    async function addFiles(files, meta) {
        if (!C || C.posting) return;
        let added = 0;
        for (const f of files) {
            if (C.drafts.length >= MAX_DRAFTS) { toast('You can add up to ' + MAX_DRAFTS + ' items at once.'); break; }
            try { C.drafts.push(await makeDraft(f, meta || {})); added++; }
            catch (e) { toast((f.name || 'File') + ': ' + (e && e.message ? e.message : 'unsupported file')); }
            if (!C) return;
        }
        if (added) { C.cur = C.drafts.length - 1; C.sel = -1; C.tool = null; stopCamera(); setView('edit'); }
        else if (C.view === 'picker' || C.view === 'cam') { /* stay */ }
    }
    async function makeDraft(file, meta) {
        const type = baseType(file.type) || typeFromName(file.name);
        const isImg = /^image\/(jpeg|png|webp)$/.test(type);
        const isVid = /^video\/(mp4|webm|quicktime)$/.test(type);
        if (!isImg && !isVid) throw new Error('unsupported format (use JPG, PNG, WebP, MP4, WebM or MOV)');
        if (isImg && file.size > MAX_IMAGE_RAW) throw new Error('photo is too large (max 30 MB)');
        if (isVid && file.size > MAX_VIDEO) throw new Error('video is too large (max 6 MB — record in the camera or trim it first)');
        if (!file.size) throw new Error('file is empty');
        const d = { id: newId(), file, type, kind: isImg ? 'image' : 'video', url: URL.createObjectURL(file), width: 0, height: 0, duration: 0, ov: [], status: 'ready', progress: 0, error: '', uploaded: false, published: false, attempts: 0 };
        try {
            if (isImg) {
                const bmp = await createImageBitmap(file);
                d.width = bmp.width; d.height = bmp.height;
                if (bmp.close) bmp.close();
            } else {
                await new Promise((res, rej) => {
                    const v = document.createElement('video');
                    v.preload = 'metadata'; v.muted = true;
                    v.onloadedmetadata = () => { d.width = v.videoWidth; d.height = v.videoHeight; d.duration = isFinite(v.duration) ? v.duration : 0; res(); };
                    v.onerror = () => rej(new Error('this video can’t be read by your browser'));
                    v.src = d.url;
                });
                if (!d.duration && meta.duration) d.duration = meta.duration;
                if (meta.duration && (!d.duration || d.duration > meta.duration + 1)) d.duration = meta.duration;
                if (d.duration > MAX_VIDEO_SEC + 0.5) throw new Error('videos can be up to 30 seconds');
                if (!d.width || !d.height) throw new Error('this video can’t be read by your browser');
            }
        } catch (e) {
            URL.revokeObjectURL(d.url);
            throw e instanceof Error && e.message !== 'The source image could not be decoded.' ? e : new Error('unsupported or corrupt image');
        }
        return d;
    }

    /* ---------- editor ---------- */
    const draft = () => C.drafts[C.cur];

    function viewEditor() {
        stopCamera();
        const d = draft();
        if (!d) { setView('picker'); return; }
        const panel = h('div', 'cp-panel');
        const stage = h('div', 'cp-stage');
        let media;
        if (d.kind === 'image') { media = new Image(); media.draggable = false; media.src = d.url; }
        else { media = document.createElement('video'); media.src = d.url; media.muted = true; media.loop = true; media.autoplay = true; media.playsInline = true; media.setAttribute('playsinline', ''); media.play().catch(() => {}); }
        stage.appendChild(media);
        panel.appendChild(stage);
        const trash = h('div', 'cp-trash', '🗑');
        stage.appendChild(trash);
        C.main.appendChild(panel);
        Object.assign(C, { panel, stage, trash });

        const layout = () => { fitStage(panel, stage, d.width / d.height); refreshOverlays(); };
        const ro = new ResizeObserver(layout);
        ro.observe(panel); C.observers.push(ro);
        layout();

        /* tools */
        const tools = h('div', 'cp-tools');
        const mk = (label, title, fn) => { const b = h('button', 'sv-iconbtn', label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; tools.appendChild(b); return b; };
        mk('Aa', 'Add text', () => openTextEditor(-1));
        C.drawBtn = mk('✏️', 'Draw', toggleDraw);
        mk('😀', 'Add emoji', openEmoji);
        mk('↶', 'Undo last change', undo);
        mk('🗑️', 'Remove this photo/video', removeDraft);
        panel.appendChild(tools);
        C.selBar = h('div', 'cp-sel');
        C.selBar.style.display = 'none';
        panel.appendChild(C.selBar);
        stage.addEventListener('pointerdown', (e) => { if (e.target === stage || e.target === media || e.target.classList.contains('ov-layer') || e.target.tagName === 'CANVAS') select(-1); });

        /* footer */
        const strip = h('div', 'cp-strip');
        C.drafts.forEach((x, i) => {
            const t = x.kind === 'image' ? h('img', 'cp-thumb' + (i === C.cur ? ' on' : '')) : h('video', 'cp-thumb' + (i === C.cur ? ' on' : ''));
            if (x.kind === 'video') { t.muted = true; t.preload = 'metadata'; t.src = x.url + '#t=0.1'; } else t.src = x.url;
            t.onclick = () => { C.cur = i; C.sel = -1; C.tool = null; setView('edit'); };
            strip.appendChild(t);
        });
        if (C.drafts.length < MAX_DRAFTS) {
            const add = h('button', 'cp-addmore', '+');
            add.title = 'Add more photos or videos';
            add.onclick = () => setView('picker');
            strip.appendChild(add);
        }
        const aud = h('button', 's-btn ghost', audienceLabel());
        aud.onclick = openAudience;
        const post = h('button', 's-btn', C.drafts.length > 1 ? 'Post ' + C.drafts.length : 'Post');
        post.onclick = startPosting;
        C.foot.append(strip, aud, post);
        updateSel();
    }
    function audienceLabel() {
        if (C.vis === 'private') return '🔒 Private (' + C.audience.size + ')';
        if (C.vis === 'custom') return '👥 Custom' + (C.excluded.size ? ' (−' + C.excluded.size + ')' : '');
        return '👥 Friends';
    }

    function refreshOverlays() {
        const d = draft(); if (!d || !C.stage) return;
        const layer = renderOverlays(C.stage, d.ov);
        const items = [...layer.querySelectorAll('.ov-item')];
        let k = 0;
        d.ov.forEach((o, i) => { if (o.type !== 'draw') { const el = items[k++]; el._oi = i; wireItem(el, i); } });
        C.stage.classList.toggle('drawing', C.tool === 'draw');
        markSel();
    }
    function markSel() {
        if (!C.stage) return;
        C.stage.querySelectorAll('.ov-item').forEach((el) => el.classList.toggle('sel', el._oi === C.sel));
        updateSel();
    }
    function select(i) {
        if (C.sel === i) return;
        C.sel = i;
        markSel();
    }
    function applyEl(el, o) {
        el.style.left = (o.x * 100) + '%';
        el.style.top = (o.y * 100) + '%';
        el.style.fontSize = 'calc(var(--u) * ' + o.scale + ')';
        el.style.transform = 'translate(-50%, -50%) rotate(' + o.rot + 'deg)';
        if (o.type === 'text') el.style.color = o.color;
    }
    const elOf = (i) => [...C.stage.querySelectorAll('.ov-item')].find((e) => e._oi === i);
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

    function wireItem(el, oi) {
        const d = draft();
        const pts = new Map();
        let base = null, moved = false, wasSel = false, t0 = 0;
        const rebase = () => {
            const o = d.ov[oi]; const p = [...pts.values()];
            base = { x: o.x, y: o.y, scale: o.scale, rot: o.rot, p0: p[0], dist: p[1] ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0, ang: p[1] ? Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x) : 0 };
        };
        el.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!pts.size) { wasSel = C.sel === oi; moved = false; t0 = Date.now(); }
            select(oi);
            el.setPointerCapture(e.pointerId);
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            rebase();
            C.trash.classList.add('show');
        });
        el.addEventListener('pointermove', (e) => {
            if (!pts.has(e.pointerId)) return;
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const o = d.ov[oi]; const p = [...pts.values()];
            if (Math.hypot(e.clientX - base.p0.x, e.clientY - base.p0.y) > 4 || p.length > 1) moved = true;
            if (p.length === 1) {
                o.x = clamp(base.x + (p[0].x - base.p0.x) / C.stage._w, 0, 1);
                o.y = clamp(base.y + (p[0].y - base.p0.y) / C.stage._h, 0, 1);
            } else {
                const dist = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
                const ang = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
                o.scale = clamp(base.scale * (dist / (base.dist || 1)), 2, 60);
                o.rot = base.rot + (ang - base.ang) * 180 / Math.PI;
            }
            applyEl(el, o);
            const r = C.trash.getBoundingClientRect();
            C.trash.classList.toggle('hot', e.clientX > r.left - 20 && e.clientX < r.right + 20 && e.clientY > r.top - 20 && e.clientY < r.bottom + 20);
            updateSel();
        });
        const up = (e) => {
            if (!pts.has(e.pointerId)) return;
            const hot = C.trash.classList.contains('hot');
            pts.delete(e.pointerId);
            if (pts.size) { rebase(); return; }
            C.trash.classList.remove('show', 'hot');
            if (hot && moved) { removeItem(oi); return; }
            if (!moved && wasSel && Date.now() - t0 < 300 && d.ov[oi].type === 'text') openTextEditor(oi);
        };
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('wheel', (e) => { e.preventDefault(); const o = d.ov[oi]; o.scale = clamp(o.scale * (e.deltaY < 0 ? 1.06 : 0.94), 2, 60); applyEl(el, o); updateSel(); }, { passive: false });
    }

    function removeItem(i) {
        const d = draft();
        d.ov.splice(i, 1);
        C.sel = -1;
        refreshOverlays();
    }
    function undo() {
        const d = draft();
        if (!d.ov.length) return;
        d.ov.pop();
        C.sel = -1;
        refreshOverlays();
    }
    async function removeDraft() {
        const ok = await confirmDialog('Remove this ' + (draft().kind === 'image' ? 'photo' : 'video') + '?', 'It won’t be added to your story.', 'Remove');
        if (!ok || !C) return;
        dropUploaded(draft());
        URL.revokeObjectURL(draft().url);
        C.drafts.splice(C.cur, 1);
        C.cur = Math.min(C.cur, C.drafts.length - 1);
        C.sel = -1; C.tool = null;
        setView(C.drafts.length ? 'edit' : 'picker');
    }

    function colorRow(current, onPick) {
        const row = h('div', 'cp-colors');
        COLORS.forEach((c) => {
            const b = h('button', c === current ? 'on' : ''); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Color ' + c);
            b.onclick = () => { row.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onPick(c); };
            row.appendChild(b);
        });
        return row;
    }
    function slider(min, max, step, val, onInput) {
        const r = document.createElement('input');
        r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val;
        r.oninput = () => onInput(parseFloat(r.value));
        return r;
    }
    function updateSel() {
        const bar = C.selBar; if (!bar) return;
        const d = draft();
        bar.textContent = '';
        if (C.tool === 'draw') {
            bar.style.display = 'flex';
            bar.append(colorRow(C.color, (c) => { C.color = c; }), slider(0.4, 4, 0.1, C.brush, (v) => { C.brush = v; }));
            return;
        }
        const o = C.sel >= 0 ? d.ov[C.sel] : null;
        if (!o) { bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        bar.appendChild(slider(2, 40, 0.5, o.scale, (v) => { o.scale = v; const el = elOf(C.sel); if (el) applyEl(el, o); }));
        if (o.type === 'text') {
            bar.appendChild(colorRow(o.color, (c) => { o.color = c; const el = elOf(C.sel); if (el) applyEl(el, o); }));
            const ed = h('button', 'sv-iconbtn', '✎'); ed.title = 'Edit text'; ed.onclick = () => openTextEditor(C.sel);
            bar.appendChild(ed);
        }
        const del = h('button', 'sv-iconbtn', '🗑️'); del.title = 'Delete'; del.onclick = () => removeItem(C.sel);
        bar.appendChild(del);
    }

    /* text / emoji / drawing */
    function openTextEditor(oi) {
        const d = draft();
        const existing = oi >= 0 ? d.ov[oi] : null;
        let color = existing ? existing.color : C.color;
        openSheet((sheet, api) => {
            sheet.appendChild(h('h3', '', existing ? 'Edit text' : 'Add text'));
            const ta = h('textarea', 'cp-text-input');
            ta.maxLength = 120; ta.placeholder = 'Type something…'; ta.value = existing ? existing.text : '';
            ta.style.color = color;
            sheet.appendChild(ta);
            sheet.appendChild(h('div')).style.height = '10px';
            sheet.appendChild(colorRow(color, (c) => { color = c; ta.style.color = c; }));
            const acts = h('div', 'row-actions');
            const cancel = h('button', 's-btn ghost', 'Cancel'); cancel.onclick = api.close;
            const done = h('button', 's-btn', 'Done');
            done.onclick = () => {
                const text = ta.value.trim();
                api.close();
                if (!C) return;
                if (existing) { if (!text) { removeItem(oi); return; } existing.text = text; existing.color = color; }
                else if (text) { d.ov.push({ type: 'text', text, color, x: 0.5, y: 0.5, scale: 8, rot: 0 }); C.sel = d.ov.length - 1; }
                C.color = color;
                refreshOverlays();
            };
            acts.append(cancel, done);
            sheet.appendChild(acts);
            setTimeout(() => ta.focus(), 50);
        });
    }
    function openEmoji() {
        const d = draft();
        openSheet((sheet, api) => {
            sheet.appendChild(h('h3', '', 'Emoji'));
            const grid = h('div', 'cp-emoji-grid');
            EMOJIS.forEach((em) => {
                const b = h('button', '', em); b.type = 'button';
                b.onclick = () => { api.close(); d.ov.push({ type: 'emoji', text: em, color: '#fff', x: 0.5, y: 0.5, scale: 16, rot: 0 }); C.sel = d.ov.length - 1; refreshOverlays(); };
                grid.appendChild(b);
            });
            sheet.appendChild(grid);
        });
    }
    function toggleDraw() {
        C.tool = C.tool === 'draw' ? null : 'draw';
        C.sel = -1;
        C.drawBtn.classList.toggle('active', C.tool === 'draw');
        C.stage.classList.toggle('drawing', C.tool === 'draw');
        C.stage.querySelectorAll('.cp-cap').forEach((n) => n.remove());
        if (C.tool === 'draw') {
            const cap = h('div', 'cp-cap');
            C.stage.appendChild(cap);
            let stroke = null;
            const pt = (e) => { const r = C.stage.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)].map((v) => Math.round(v * 1000) / 1000); };
            cap.addEventListener('pointerdown', (e) => {
                cap.setPointerCapture(e.pointerId);
                stroke = { type: 'draw', color: C.color, size: C.brush, points: [pt(e)] };
                draft().ov.push(stroke);
                redrawStrokes();
            });
            cap.addEventListener('pointermove', (e) => {
                if (!stroke) return;
                const p = pt(e), l = stroke.points[stroke.points.length - 1];
                if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 0.004) return;
                stroke.points.push(p);
                redrawStrokes();
            });
            const end = () => { stroke = null; };
            cap.addEventListener('pointerup', end);
            cap.addEventListener('pointercancel', end);
        }
        updateSel();
    }
    function redrawStrokes() {
        const c = C.stage.querySelector('.ov-canvas');
        if (c) drawStrokes(c, draft().ov, C.stage._w, C.stage._h);
    }

    /* ---------- audience / privacy ---------- */
    function openAudience() {
        const friends = [...S.friends].filter((f) => !S.blocked.has(f));
        openSheet((sheet, api) => {
            let vis = C.vis;
            const aud = new Set(C.audience);
            const exc = new Set(C.excluded);
            const render = () => {
                sheet.textContent = '';
                sheet.appendChild(h('h3', '', 'Who can see this?'));
                const seg = h('div', 'cp-seg');
                [['friends', 'Friends'], ['custom', 'Custom'], ['private', 'Private']].forEach(([k, l]) => {
                    const b = h('button', vis === k ? 'on' : '', l); b.type = 'button';
                    b.onclick = () => { vis = k; render(); };
                    seg.appendChild(b);
                });
                sheet.appendChild(seg);
                sheet.appendChild(h('p', 'sub', vis === 'friends' ? 'All your accepted friends can view this for 24 hours.'
                    : vis === 'custom' ? 'Friends can view this, except the people you hide it from.'
                        : 'Only the friends you pick can view this. It stays separate from your regular story.'));
                if (vis !== 'friends') {
                    const set = vis === 'custom' ? exc : aud;
                    sheet.appendChild(h('b', '', vis === 'custom' ? 'Hide from' : 'Share with'));
                    if (!friends.length) sheet.appendChild(h('div', 's-empty', 'Add friends first'));
                    friends.forEach((uid) => {
                        const p = profile(uid);
                        const row = h('label', 's-row s-check');
                        const img = h('img', 'av'); avatar(img, uid);
                        const g = h('div', 'grow'); g.appendChild(h('b', '', p.username));
                        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = set.has(uid);
                        cb.onchange = () => { if (cb.checked) set.add(uid); else set.delete(uid); };
                        row.append(img, g, cb);
                        sheet.appendChild(row);
                        if (p.ready) p.ready.then(() => { if (g.firstChild && g.firstChild.textContent === '…') { g.firstChild.textContent = p.username; avatar(img, uid); } });
                    });
                }
                const acts = h('div', 'row-actions');
                const cancel = h('button', 's-btn ghost', 'Cancel'); cancel.onclick = api.close;
                const save = h('button', 's-btn', 'Done');
                save.onclick = async () => {
                    if (vis === 'private' && !aud.size) { toast('Pick at least one friend for a private story.'); return; }
                    save.disabled = true;
                    if (vis === 'custom') {
                        const obj = {}; exc.forEach((u) => { obj[u] = true; });
                        try { await db().ref('storySettings/' + C.me + '/excluded').set(exc.size ? obj : null); }
                        catch (e) { toast('Couldn’t save your privacy list.'); save.disabled = false; return; }
                    }
                    C.vis = vis; C.audience = aud; C.excluded = exc;
                    if (vis !== 'private') localStorage.setItem('mesnap_story_vis', vis);
                    api.close();
                    if (C && C.view === 'edit') setView('edit');
                };
                acts.append(cancel, save);
                sheet.appendChild(acts);
            };
            render();
        });
    }

    /* ---------- posting ---------- */
    async function prepare(d) {
        const ov = d.ov.length ? JSON.stringify(d.ov.map((o) => (o.type === 'draw' ? { ...o, points: o.points.map((p) => [+p[0].toFixed(3), +p[1].toFixed(3)]) } : o))) : null;
        if (ov && ov.length > 55000) throw new Error('Too many drawings on this item — undo some strokes.');
        d.overlaysJson = ov;
        if (d.blob) return;
        if (d.kind === 'image') {
            const bmp = await createImageBitmap(d.file);
            const k = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
            const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = hh;
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, hh);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bmp, 0, 0, w, hh);
            if (bmp.close) bmp.close();
            let blob = null;
            for (const q of [0.82, 0.7, 0.58, 0.46]) {
                blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
                if (!blob) throw new Error('Couldn’t process this photo.');
                if (blob.size <= MAX_IMAGE_OUT) break;
            }
            if (blob.size > MAX_IMAGE_OUT * 1.4) throw new Error('This photo is too detailed to store. Try a simpler one.');
            d.blob = blob;
            d.contentType = 'image/jpeg';
            d.width = w; d.height = hh;
        } else {
            d.blob = d.file;
            d.contentType = d.type;
        }
    }
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',')[1] || '');
            r.onerror = () => reject(new Error('Couldn’t read this file.'));
            r.readAsDataURL(blob);
        });
    }
    const withTimeout = (p, ms) => new Promise((resolve, reject) => {
        const t = setTimeout(() => { const e = new Error('Upload is not progressing. Check your connection and retry.'); e.code = 'upload/stalled'; reject(e); }, ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
    // Media is stored as base64 chunks in the Realtime Database (no Firebase Storage needed).
    async function uploadBlob(d) {
        if (!d.b64) d.b64 = await blobToBase64(d.blob);
        const n = Math.ceil(d.b64.length / CHUNK);
        if (n > MAX_CHUNKS) throw new Error('This file is too large to post. Use a shorter video or a smaller photo.');
        d.chunks = n;
        const base = 'storyMedia/' + C.me + '/' + d.id + '/';
        d.chunkDone = d.chunkDone || 0;
        for (let i = d.chunkDone; i < n; i++) {
            await withTimeout(db().ref(base + i).set(d.b64.slice(i * CHUNK, (i + 1) * CHUNK)), 30000);
            d.chunkDone = i + 1;
            d.progress = d.chunkDone / n; paintPost();
        }
    }
    async function publish(d) {
        const me = C.me;
        const TS = firebase.database.ServerValue.TIMESTAMP;
        const story = { mediaType: d.kind, mime: d.contentType, chunks: d.chunks, width: d.width, height: d.height, visibility: C.vis, createdAt: TS };
        if (d.kind === 'video' && d.duration) story.duration = Math.round(d.duration * 10) / 10;
        if (d.overlaysJson) story.overlays = d.overlaysJson;
        const up = {};
        up['storyMeta/' + me + '/lastPostAt'] = TS;
        if (C.vis === 'private') {
            story.audience = {};
            C.audience.forEach((u) => { story.audience[u] = true; up['storyInbox/' + u + '/' + d.id] = { owner: me, createdAt: TS }; });
        } else {
            up['storyIndex/' + me + '/' + d.id] = { createdAt: TS };
        }
        up['stories/' + me + '/' + d.id] = story;
        const wait = 1150 - (Date.now() - C.lastPostAt);
        if (wait > 0) await sleep(wait);
        try { await db().ref().update(up); }
        catch (e) {
            const exists = await db().ref('stories/' + me + '/' + d.id).once('value').then((s) => s.exists()).catch(() => false);
            if (!exists) throw e;
        }
        C.lastPostAt = Date.now();
    }
    function friendlyError(e) {
        const c = (e && e.code) || '';
        if (c === 'PERMISSION_DENIED') return 'The database rejected this post. Check that the Stories database rules are published, and that you aren’t posting too fast.';
        if (/network|disconnect/i.test(c)) return 'Connection problem. Check your internet and retry.';
        return (e && e.message) || 'Something went wrong. Please retry.';
    }
    async function runDraft(d) {
        d.status = 'working'; d.error = ''; paintPost();
        try {
            await prepare(d);
            if (!d.uploaded) {
                d.attempts++;
                await uploadBlob(d);
                d.uploaded = true; d.progress = 1;
            }
            if (!d.published) { await publish(d); d.published = true; }
            d.status = 'done';
        } catch (e) {
            d.status = 'failed'; d.error = friendlyError(e);
        }
        paintPost();
    }
    async function startPosting() {
        if (C.posting || !C.drafts.length) return;
        if (C.vis === 'private' && !C.audience.size) { toast('Pick at least one friend for a private story.'); return openAudience(); }
        if (!navigator.onLine) toast('You appear to be offline — uploads will retry when you reconnect.');
        C.posting = true;
        setView('post');
        await runAll();
    }
    async function runAll() {
        C.posting = true; paintPost();
        for (const d of C.drafts) { if (!C) return; if (d.status !== 'done') await runDraft(d); }
        if (!C) return;
        C.posting = false;
        paintPost();
        if (C.drafts.every((d) => d.status === 'done')) {
            const n = C.drafts.length;
            close();
            toast(n > 1 ? 'Posted ' + n + ' items to your story' : 'Posted to your story');
        }
    }
    function viewPosting() {
        const list = h('div', 'cp-upl');
        C.upl = list;
        C.main.appendChild(list);
        paintPost();
    }
    function paintPost() {
        if (!C || C.view !== 'post' || !C.upl) return;
        const list = C.upl;
        list.textContent = '';
        C.drafts.forEach((d) => {
            const it = h('div', 'item');
            const th = d.kind === 'image' ? h('img') : h('video');
            th.src = d.kind === 'image' ? d.url : d.url + '#t=0.1';
            const g = h('div'); g.style.flex = '1'; g.style.minWidth = '0';
            const label = d.status === 'done' ? '✓ Posted' : d.status === 'failed' ? 'Failed' : d.status === 'working' ? (d.progress < 1 ? 'Uploading ' + Math.round(d.progress * 100) + '%' : 'Publishing…') : 'Waiting…';
            g.appendChild(h('b', '', (d.kind === 'image' ? 'Photo' : 'Video') + ' · ' + label));
            const bar = h('div', 'cp-bar'); const fill = h('i'); fill.style.width = (d.status === 'done' ? 100 : Math.round(d.progress * 100)) + '%'; bar.appendChild(fill);
            g.appendChild(bar);
            if (d.error) g.appendChild(h('div', 'cp-err', d.error));
            it.append(th, g);
            list.appendChild(it);
        });
        const acts = h('div', 'row-actions'); acts.style.display = 'flex'; acts.style.gap = '10px'; acts.style.justifyContent = 'center';
        if (!C.posting && C.drafts.some((d) => d.status === 'failed')) {
            const retry = h('button', 's-btn', 'Retry failed'); retry.onclick = () => runAll();
            const back = h('button', 's-btn ghost', 'Back to editing'); back.onclick = () => { C.drafts.forEach((d) => { if (d.status === 'failed') d.status = 'ready'; }); setView('edit'); };
            acts.append(retry, back);
            list.appendChild(acts);
        } else if (C.posting) {
            const cancel = h('button', 's-btn ghost', 'Cancel'); cancel.onclick = requestClose;
            acts.appendChild(cancel);
            list.appendChild(acts);
        }
    }

    window.Stories._openComposer = open;
    window.Stories._composerReset = () => { if (C) close(); };
})();
