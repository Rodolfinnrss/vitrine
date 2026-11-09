// Vitrine — loja de aplicativos Flatpak para Ubuntu
// Processo principal em GJS (JavaScript do GNOME) + GTK3 + WebKitGTK.
// A interface fica em ui/ (HTML/CSS/JS) e conversa com este arquivo por uma
// ponte de mensagens. Aqui é onde os comandos `flatpak` são executados.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';
import Soup from 'gi://Soup?version=3.0';
import Cairo from 'cairo';
import System from 'system';

function signalAdder() {
    try {
        return imports.gi.GLibUnix.signal_add;
    } catch {
        return GLib.unix_signal_add;
    }
}

void Cairo; // garante o suporte a superfícies cairo (snapshots de teste)

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const APP_ID = 'io.github.vitrine.Loja';
const ROOT = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const UI_FILE = GLib.build_filenamev([ROOT, 'ui', 'index.html']);
const ICON_FILE = GLib.build_filenamev([ROOT, 'ui', 'icon.svg']);
const TEST = GLib.getenv('VITRINE_TEST');
const DEBUG = !!GLib.getenv('VITRINE_DEBUG') || !!TEST;
const FLATHUB_REPO = 'https://dl.flathub.org/repo/flathub.flatpakrepo';
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$/;
const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'vitrine']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'config.json']);

GLib.set_prgname('vitrine');
GLib.set_application_name('Vitrine');

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();
const http = new Soup.Session({user_agent: 'Vitrine/1.0 (Flatpak store)', timeout: 30});

let webView = null;
let win = null;

// ───────────────────────── utilidades ─────────────────────────

function flatpakBin() {
    return GLib.getenv('VITRINE_FLATPAK') || GLib.find_program_in_path('flatpak');
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Posição até onde o buffer contém UTF-8 completo (o resto fica para o próximo pedaço)
function utf8Boundary(buf) {
    let i = buf.length - 1;
    let cont = 0;
    while (i >= 0 && cont < 3 && (buf[i] & 0xC0) === 0x80) { i--; cont++; }
    if (i < 0) return buf.length;
    const b = buf[i];
    const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
    return buf.length - i >= need ? buf.length : i;
}

function readConfig() {
    try {
        const [, bytes] = GLib.file_get_contents(CONFIG_FILE);
        return JSON.parse(decoder.decode(bytes));
    } catch {
        return {};
    }
}

function writeConfig(cfg) {
    GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
    GLib.file_set_contents(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function launcher(flags) {
    const l = new Gio.SubprocessLauncher({flags});
    l.setenv('LC_ALL', 'C.UTF-8', true);
    l.setenv('LANG', 'C.UTF-8', true);
    l.setenv('TERM', 'xterm-256color', true);
    l.setenv('COLUMNS', '110', true);
    return l;
}

async function run(argv) {
    try {
        const p = launcher(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE).spawnv(argv);
        const [out, err] = await p.communicate_utf8_async(null, null);
        return {ok: p.get_successful(), out: out ?? '', err: err ?? ''};
    } catch (e) {
        return {ok: false, out: '', err: String(e.message ?? e)};
    }
}

function rows(text) {
    return text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim()).map(l => l.split('\t'));
}

function emit(obj) {
    if (!webView) return;
    const js = `window.__vitrine && window.__vitrine.receive(${JSON.stringify(obj)})`;
    webView.evaluate_javascript(js, -1, null, null, null, null);
}

function openUri(uri) {
    if (!/^(https?|mailto):/i.test(uri)) return;
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (e) {
        log(`não foi possível abrir ${uri}: ${e.message}`);
    }
}

// ───────────────────────── informações do flatpak ─────────────────────────

async function remotesFor(scope) {
    const fp = flatpakBin();
    const r = await run([fp, 'remotes', `--${scope}`, '--columns=name,url']);
    if (!r.ok) return null;
    for (const [name, url = ''] of rows(r.out)) {
        if (name === 'flathub' || /flathub\.org\/repo/.test(url)) return name;
    }
    return null;
}

async function envInfo() {
    const fp = flatpakBin();
    const info = {flatpak: !!fp, version: null, arch: null, remotes: {user: null, system: null}};
    if (!fp) return info;
    const [v, a, ru, rs] = await Promise.all([
        run([fp, '--version']),
        run([fp, '--default-arch']),
        remotesFor('user'),
        remotesFor('system'),
    ]);
    info.version = v.out.trim().replace(/^Flatpak\s*/i, '');
    info.arch = a.out.trim();
    info.remotes = {user: ru, system: rs};
    return info;
}

async function listInstalled() {
    const fp = flatpakBin();
    if (!fp) return [];
    const r = await run([fp, 'list', '--app', '--columns=application,name,version,branch,origin,installation,size']);
    if (!r.ok) return [];
    return rows(r.out)
        .filter(([id]) => ID_RE.test(id ?? ''))
        .map(([id, name, version, branch, origin, installation, size]) =>
            ({id, name, version, branch, origin, installation, size}));
}

async function listUpdates() {
    const fp = flatpakBin();
    if (!fp) return [];
    const out = [];
    for (const scope of ['user', 'system']) {
        const r = await run([fp, 'remote-ls', `--${scope}`, '--updates', '--app', '--columns=application,version,origin']);
        if (!r.ok) continue;
        for (const [id, version, origin] of rows(r.out))
            if (ID_RE.test(id ?? '')) out.push({id, version, origin, scope});
    }
    return out;
}

async function ensureRemote(scope, op) {
    const name = await remotesFor(scope);
    if (name) return name;
    const fp = flatpakBin();
    op.term.write(`$ flatpak remote-add --${scope} --if-not-exists flathub ${FLATHUB_REPO}\n`);
    const r = await run([fp, 'remote-add', `--${scope}`, '--if-not-exists', 'flathub', FLATHUB_REPO]);
    op.term.write(r.out + r.err);
    if (!r.ok) throw new Error(r.err.trim() || 'não foi possível adicionar o repositório Flathub');
    return 'flathub';
}

// ───────────────────────── mini terminal ─────────────────────────
// Interpreta a saída "bonita" do flatpak (barras de progresso com \r e
// movimentos de cursor) para mostrar um log limpo e extrair a porcentagem.

class Term {
    constructor(max = 500) {
        this.lines = [''];
        this.row = 0;
        this.col = 0;
        this.max = max;
        this.pending = '';
    }

    write(s) {
        s = this.pending + s;
        this.pending = '';
        const cut = s.match(/\x1b(\[[0-9;?]*|\][^\x07]*)?$/);
        if (cut) {
            this.pending = cut[0];
            s = s.slice(0, -cut[0].length);
        }
        const re = /\x1b\[([0-9;?]*)([A-Za-z@])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEM]|\r|\n|\x08|[\x00-\x07\x0b\x0c\x0e-\x1a\x1c-\x1f]/g;
        let last = 0;
        let m;
        while ((m = re.exec(s))) {
            this.text(s.slice(last, m.index));
            this.ctrl(m);
            last = re.lastIndex;
        }
        this.text(s.slice(last));
        const extra = this.lines.length - this.max;
        if (extra > 0) {
            this.lines.splice(0, extra);
            this.row = Math.max(0, this.row - extra);
        }
    }

    text(t) {
        if (!t) return;
        let line = this.lines[this.row] ?? '';
        if (line.length < this.col) line += ' '.repeat(this.col - line.length);
        this.lines[this.row] = line.slice(0, this.col) + t + line.slice(this.col + t.length);
        this.col += t.length;
    }

    ensureRow() {
        while (this.lines.length <= this.row) this.lines.push('');
    }

    ctrl(m) {
        const tok = m[0];
        if (tok === '\r') { this.col = 0; return; }
        if (tok === '\n') { this.row++; this.col = 0; this.ensureRow(); return; }
        if (tok === '\x08') { this.col = Math.max(0, this.col - 1); return; }
        if (!m[2]) return;
        const n = parseInt(m[1]) || 1;
        const mode = parseInt(m[1]) || 0;
        const line = this.lines[this.row] ?? '';
        switch (m[2]) {
        case 'A': this.row = Math.max(0, this.row - n); break;
        case 'B': this.row += n; this.ensureRow(); break;
        case 'C': this.col += n; break;
        case 'D': this.col = Math.max(0, this.col - n); break;
        case 'E': this.row += n; this.col = 0; this.ensureRow(); break;
        case 'F': this.row = Math.max(0, this.row - n); this.col = 0; break;
        case 'G': this.col = n - 1; break;
        case 'K':
            if (mode === 0) this.lines[this.row] = line.slice(0, this.col);
            else if (mode === 1) this.lines[this.row] = ' '.repeat(this.col) + line.slice(this.col);
            else this.lines[this.row] = '';
            break;
        case 'J':
            if (mode === 0) {
                this.lines[this.row] = line.slice(0, this.col);
                this.lines.length = this.row + 1;
            } else if (mode === 2 || mode === 3) {
                this.lines = [''];
                this.row = 0;
                this.col = 0;
            }
            break;
        }
    }

    get tail() {
        return this.lines.slice(-160).join('\n').replace(/\s+$/, '');
    }
}

// ───────────────────────── fila de operações ─────────────────────────

const ops = new Map();
const queue = [];
let current = null;
let opSeq = 0;

const VERBS = {
    install: 'Instalando',
    uninstall: 'Removendo',
    update: 'Atualizando',
    setup: 'Configurando o Flatpak',
};

function publicOp(op) {
    return {
        opId: op.opId, kind: op.kind, appId: op.appId, name: op.name, icon: op.icon,
        scope: op.scope, status: op.status, progress: op.progress, phase: op.phase,
        error: op.error, cmd: op.cmd, tail: op.term.tail, startedAt: op.startedAt,
    };
}

function emitOp(op) {
    if (op._timer) {
        GLib.source_remove(op._timer);
        op._timer = 0;
    }
    emit({type: 'op', op: publicOp(op)});
}

function scheduleEmit(op) {
    if (op._timer) return;
    op._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        op._timer = 0;
        emit({type: 'op', op: publicOp(op)});
        return GLib.SOURCE_REMOVE;
    });
}

function enqueue({kind, appId = null, scope = 'user', name = null, icon = null}) {
    if (kind !== 'setup' && appId !== null && !ID_RE.test(appId)) throw new Error('ID de aplicativo inválido');
    if (scope !== 'user' && scope !== 'system') throw new Error('escopo inválido');
    if (kind !== 'setup' && !flatpakBin()) throw new Error('O Flatpak não está instalado');
    for (const op of ops.values()) {
        if (op.kind === kind && op.appId === appId && (op.status === 'queued' || op.status === 'running'))
            return publicOp(op);
    }
    const op = {
        opId: `op${++opSeq}`, kind, appId, scope, name: name ?? appId, icon,
        status: 'queued', progress: null, phase: 'Na fila', error: null, cmd: '',
        term: new Term(), proc: null, _timer: 0, startedAt: null,
    };
    ops.set(op.opId, op);
    queue.push(op);
    emitOp(op);
    pump();
    return publicOp(op);
}

async function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    try {
        await execOp(current);
    } catch (e) {
        current.status = 'error';
        current.error = String(e.message ?? e);
        current.term.write(`\n${current.error}\n`);
    } finally {
        const done = current;
        current = null;
        emitOp(done);
        if (done.kind !== 'setup' || done.status === 'done') emit({type: 'installed-changed', kind: done.kind});
        if (done.kind === 'setup') emit({type: 'env-changed'});
        pump();
    }
}

function cancelOp(opId) {
    const op = ops.get(opId);
    if (!op) return false;
    if (op.status === 'queued') {
        const i = queue.indexOf(op);
        if (i >= 0) queue.splice(i, 1);
        op.status = 'cancelled';
        op.phase = 'Cancelado';
        emitOp(op);
        return true;
    }
    if (op.status === 'running' && op.proc) {
        op.cancelled = true;
        op.phase = 'Cancelando…';
        op.proc.send_signal(15);
        emitOp(op);
        return true;
    }
    return false;
}

const SETUP_SCRIPT = [
    'export DEBIAN_FRONTEND=noninteractive',
    'echo "› Atualizando a lista de pacotes…"',
    'apt-get update || true',
    'echo "› Instalando o Flatpak…"',
    'apt-get install -y flatpak',
    'echo "› Adicionando o repositório Flathub…"',
    `flatpak remote-add --if-not-exists flathub ${FLATHUB_REPO}`,
    'echo "✓ Pronto"',
].join('\n');

function parseProgress(op) {
    const lines = op.term.lines;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
        const l = lines[i];
        const step = l.match(/\b(Installing|Updating|Uninstalling|Downloading)\b\D{0,6}?(\d+)\/(\d+)/i);
        const pcts = [...l.matchAll(/(\d{1,3})\s?%/g)];
        const pct = pcts.length ? Math.min(100, Number(pcts[pcts.length - 1][1])) / 100 : null;
        if (step) {
            const a = Number(step[2]);
            const b = Math.max(1, Number(step[3]));
            const verb = {installing: 'Instalando', updating: 'Atualizando', uninstalling: 'Removendo', downloading: 'Baixando'}[step[1].toLowerCase()];
            op.phase = b > 1 ? `${verb} ${a} de ${b}` : verb;
            op.progress = Math.min(0.999, ((a - 1) + (pct ?? 0)) / b);
            return;
        }
        if (pct !== null && op.kind !== 'setup') {
            op.progress = Math.min(0.999, pct);
            return;
        }
    }
    const lastLine = [...lines].reverse().find(l => l.trim()) ?? '';
    if (/Looking for (matches|updates)/i.test(lastLine)) op.phase = 'Procurando…';
    else if (/Required runtime|runtime/i.test(lastLine) && op.kind === 'install') op.phase = 'Preparando dependências…';
    else if (op.kind === 'setup' && /^›\s*(.+)$/.test(lastLine.trim())) op.phase = lastLine.trim().replace(/^›\s*/, '');
}

async function execOp(op) {
    op.status = 'running';
    op.startedAt = Date.now();
    op.phase = 'Preparando…';
    emitOp(op);

    const fp = flatpakBin();
    let argv;
    let usePty = false;

    switch (op.kind) {
    case 'install': {
        const remote = await ensureRemote(op.scope, op);
        argv = [fp, 'install', '-y', `--${op.scope}`, remote, op.appId];
        usePty = op.scope === 'user';
        break;
    }
    case 'uninstall':
        argv = [fp, 'uninstall', '-y', `--${op.scope}`, op.appId];
        usePty = op.scope === 'user';
        break;
    case 'update':
        argv = [fp, 'update', '-y', `--${op.scope}`, ...(op.appId ? [op.appId] : [])];
        usePty = op.scope === 'user';
        break;
    case 'setup':
        argv = ['pkexec', 'sh', '-c', SETUP_SCRIPT];
        break;
    default:
        throw new Error(`operação desconhecida: ${op.kind}`);
    }

    // Comando exibido na interface (exatamente o que é executado)
    op.cmd = op.kind === 'setup'
        ? 'pkexec apt-get install -y flatpak && flatpak remote-add flathub'
        : ['flatpak', ...argv.slice(1)].join(' ');
    op.term.write(`$ ${op.cmd}\n`);

    // No modo usuário rodamos dentro de um pseudo-terminal (via `script`) para
    // o flatpak imprimir a barra de progresso com porcentagem. No modo sistema
    // usamos pipes comuns para que a janela de senha (polkit) do GNOME apareça.
    const finalArgv = usePty
        ? ['script', '-qefc', `stty cols 110 rows 40 2>/dev/null; exec ${argv.map(shq).join(' ')}`, '/dev/null']
        : argv;

    const flags = Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE;
    const proc = launcher(flags).spawnv(finalArgv);
    op.proc = proc;
    op.phase = VERBS[op.kind] ?? 'Executando';
    emitOp(op);

    const stream = proc.get_stdout_pipe();
    let rest = new Uint8Array(0);
    try {
        for (;;) {
            const bytes = await stream.read_bytes_async(16384, GLib.PRIORITY_DEFAULT, null);
            if (!bytes || bytes.get_size() === 0) break;
            const chunk = bytes.toArray();
            const buf = new Uint8Array(rest.length + chunk.length);
            buf.set(rest);
            buf.set(chunk, rest.length);
            const cut = utf8Boundary(buf);
            rest = buf.slice(cut);
            op.term.write(decoder.decode(buf.subarray(0, cut)));
            parseProgress(op);
            scheduleEmit(op);
        }
        if (rest.length) op.term.write(decoder.decode(rest));
    } catch (e) {
        op.term.write(`\n[leitura interrompida: ${e.message}]\n`);
    }
    await proc.wait_async(null);
    op.proc = null;

    const ok = proc.get_if_exited() && proc.get_exit_status() === 0;
    if (op.cancelled) {
        op.status = 'cancelled';
        op.phase = 'Cancelado';
    } else if (ok) {
        op.status = 'done';
        op.progress = 1;
        op.phase = 'Concluído';
    } else {
        op.status = 'error';
        const errLine = [...op.term.lines].reverse().find(l => /error|erro|failed|falh/i.test(l));
        const status = proc.get_if_exited() ? proc.get_exit_status() : -1;
        op.error = (errLine ?? '').replace(/^\s*(error|erro)\s*:\s*/i, '').trim() ||
            (op.kind === 'setup' && (status === 126 || status === 127) ? 'Autorização cancelada' : `O comando terminou com código ${status}`);
        op.phase = 'Falhou';
    }
}

// ───────────────────────── ponte com a interface ─────────────────────────

async function handle(msg) {
    const {id, cmd, args = {}} = msg;
    try {
        let data = null;
        switch (cmd) {
        case 'env': data = await envInfo(); break;
        case 'installed': data = await listInstalled(); break;
        case 'updates': data = await listUpdates(); break;
        case 'ops': data = [...ops.values()].map(publicOp); break;
        case 'install':
        case 'uninstall':
        case 'update':
            data = enqueue({kind: cmd, appId: args.id ?? null, scope: args.scope ?? 'user', name: args.name, icon: args.icon});
            break;
        case 'setup': data = enqueue({kind: 'setup', name: 'Flatpak'}); break;
        case 'cancel': data = cancelOp(args.opId); break;
        case 'clear-ops':
            for (const [k, op] of ops) if (op.status !== 'queued' && op.status !== 'running') ops.delete(k);
            data = true;
            break;
        case 'launch': {
            if (!ID_RE.test(args.id ?? '')) throw new Error('ID inválido');
            const p = Gio.Subprocess.new([flatpakBin(), 'run', args.id], Gio.SubprocessFlags.NONE);
            p.wait_async(null, null);
            data = true;
            break;
        }
        case 'open': openUri(String(args.url ?? '')); data = true; break;
        case 'copy': {
            const cb = Gtk.Clipboard.get_default(Gdk.Display.get_default());
            cb.set_text(String(args.text ?? ''), -1);
            data = true;
            break;
        }
        case 'config:get': data = readConfig(); break;
        case 'config:set': writeConfig(args); data = true; break;
        case 'http': {
            const url = String(args.url ?? '');
            if (!url.startsWith('https://flathub.org/api/')) throw new Error('URL não permitida');
            const m = Soup.Message.new(args.method === 'POST' ? 'POST' : 'GET', url);
            if (args.body)
                m.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(args.body)));
            const bytes = await http.send_and_read_async(m, GLib.PRIORITY_DEFAULT, null);
            if (m.get_status() >= 400) throw new Error(`HTTP ${m.get_status()}`);
            data = decoder.decode(bytes.toArray());
            break;
        }
        default:
            throw new Error(`comando desconhecido: ${cmd}`);
        }
        emit({type: 'reply', id, ok: true, data});
    } catch (e) {
        emit({type: 'reply', id, ok: false, error: String(e.message ?? e)});
    }
}

// ───────────────────────── modo de teste (snapshots) ─────────────────────────

function sleep(ms) {
    return new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
}

function evalJS(code) {
    return new Promise(resolve => {
        webView.evaluate_javascript(code, -1, null, null, null, (wv, res) => {
            try {
                const v = wv.evaluate_javascript_finish(res);
                resolve(v.is_undefined() ? 'undefined' : v.to_json(0) ?? v.to_string());
            } catch (e) {
                resolve(`ERRO: ${e.message}`);
            }
        });
    });
}

function snapshot(file) {
    return new Promise(resolve => {
        webView.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, null, (wv, res) => {
            try {
                wv.get_snapshot_finish(res).writeToPNG(file);
                print(`[snap] ${file}`);
            } catch (e) {
                print(`[snap] ERRO ${e.message}`);
            }
            resolve();
        });
    });
}

async function runTest(app) {
    const [, bytes] = GLib.file_get_contents(TEST);
    const steps = JSON.parse(decoder.decode(bytes));
    for (const s of steps) {
        if (s.wait) await sleep(s.wait);
        if (s.js) print(`[js] ${s.label ?? ''} => ${await evalJS(s.js)}`);
        if (s.snap) await snapshot(s.snap);
    }
    app.quit();
}

// ───────────────────────── janela ─────────────────────────

const WINDOW_CSS = `
headerbar.vitrine-hb {
  background: #07080d;
  background-image: none;
  border: none;
  box-shadow: none;
  min-height: 36px;
  padding: 0 6px;
}
headerbar.vitrine-hb .title { color: #7d8399; font-weight: 600; font-size: 12px; }
headerbar.vitrine-hb button { color: #9aa0b6; background: transparent; border: none; box-shadow: none; }
headerbar.vitrine-hb button:hover { background: rgba(255,255,255,.08); }
window.vitrine-win, window.vitrine-win decoration { background: #07080d; }
`;

function buildWindow(app) {
    Gtk.Settings.get_default().gtk_application_prefer_dark_theme = true;
    const css = new Gtk.CssProvider();
    css.load_from_data(WINDOW_CSS);
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    const [w, h] = (GLib.getenv('VITRINE_SIZE') ?? '1360x880').split('x').map(Number);
    win = new Gtk.ApplicationWindow({application: app, title: 'Vitrine', default_width: w, default_height: h});
    win.get_style_context().add_class('vitrine-win');
    try { win.set_icon_from_file(ICON_FILE); } catch {}

    const header = new Gtk.HeaderBar({show_close_button: true, title: 'Vitrine'});
    header.get_style_context().add_class('vitrine-hb');
    win.set_titlebar(header);

    const ucm = new WebKit2.UserContentManager();
    ucm.register_script_message_handler('vitrine');
    ucm.connect('script-message-received::vitrine', (_m, result) => {
        try {
            const val = typeof result.get_js_value === 'function' ? result.get_js_value() : result;
            handle(JSON.parse(val.to_string()));
        } catch (e) {
            log(`mensagem inválida: ${e.message}`);
        }
    });

    webView = new WebKit2.WebView({user_content_manager: ucm});
    const s = webView.get_settings();
    s.enable_developer_extras = DEBUG;
    s.allow_file_access_from_file_urls = true;
    s.allow_universal_access_from_file_urls = true;
    s.enable_smooth_scrolling = true;
    s.enable_write_console_messages_to_stdout = DEBUG;
    s.enable_back_forward_navigation_gestures = false;
    const gpu = GLib.getenv('VITRINE_SOFTWARE') ? false : readConfig().gpu !== false;
    s.hardware_acceleration_policy = gpu ? WebKit2.HardwareAccelerationPolicy.ALWAYS : WebKit2.HardwareAccelerationPolicy.NEVER;
    printerr(`[vitrine] aceleração por GPU: ${gpu ? 'ligada' : 'desligada'}`);

    const bg = new Gdk.RGBA();
    bg.parse('#07080d');
    webView.set_background_color(bg);

    webView.connect('decide-policy', (_wv, decision, type) => {
        const T = WebKit2.PolicyDecisionType;
        if (type !== T.NAVIGATION_ACTION && type !== T.NEW_WINDOW_ACTION) return false;
        const uri = decision.get_navigation_action().get_request().get_uri();
        if (type === T.NAVIGATION_ACTION && uri.startsWith('file://')) return false;
        openUri(uri);
        decision.ignore();
        return true;
    });
    webView.connect('context-menu', () => !DEBUG);
    webView.connect('web-process-terminated', (_wv, reason) => {
        printerr(`[vitrine] processo web terminou (motivo ${reason}); recarregando`);
        webView.reload();
    });
    webView.connect('close', () => printerr('[vitrine] webview pediu para fechar'));
    win.connect('delete-event', () => { printerr('[vitrine] janela: delete-event'); return false; });
    win.connect('destroy', () => printerr('[vitrine] janela destruída'));

    let tested = false;
    webView.connect('load-changed', (_wv, ev) => {
        if (ev === WebKit2.LoadEvent.FINISHED && TEST && !tested) {
            tested = true;
            runTest(app).catch(e => { print(`[test] ERRO ${e.message}`); app.quit(); });
        }
    });

    webView.load_uri(GLib.filename_to_uri(UI_FILE, null));
    win.add(webView);
    win.show_all();
}

const application = new Gtk.Application({
    application_id: APP_ID,
    flags: TEST ? Gio.ApplicationFlags.NON_UNIQUE : (Gio.ApplicationFlags.DEFAULT_FLAGS ?? 0),
});
application.connect('activate', app => {
    if (win) win.present();
    else buildWindow(app);
});
application.connect('shutdown', () => printerr('[vitrine] aplicativo encerrando'));
for (const [sig, name] of [[1, 'SIGHUP'], [2, 'SIGINT'], [15, 'SIGTERM']]) {
    const addSignal = signalAdder();
    addSignal(GLib.PRIORITY_HIGH, sig, () => {
        printerr(`[vitrine] recebeu ${name}`);
        application.quit();
        return GLib.SOURCE_REMOVE;
    });
}
application.run([System.programInvocationName, ...ARGV]);
