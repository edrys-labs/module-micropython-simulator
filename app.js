// The simulators are MicroPython compiled to WebAssembly, made to be embedded as an iframe.
// Both speak the same message API (see README). ratio is height / width of the
// board drawing (the viewBox of the simulator's SVG), to size the frame to it.
const BOARDS = {
    "calliope-mini-3": {
        name: "Calliope mini 3",
        url: "https://simulator.python.calliope.cc/simulator.html",
        import: "from calliopemini import *",
        ratio: 219.4 / 243.7,
    },
    "microbit-v2": {
        name: "BBC micro:bit v2",
        url: "https://python-simulator.usermbit.org/v/0.1/simulator.html",
        import: "from microbit import *",
        ratio: 155.77 / 191.27,
    },
}

// edrys-Lite passes "" for a module without config
function config() {
    const config = Edrys.module?.config
    return typeof config === "object" && config || {}
}

function board() {
    return BOARDS[config().board] || BOARDS["calliope-mini-3"]
}

// the message subject the simulator runs code from
function executeSubject() {
    return config().execute || "execute"
}

// Room state is shared by all modules in the room, so the key names
// the module and the subject it listens to.
function programKey() {
    return "micropython:" + executeSubject()
}

// Message that stops the simulation on every peer of the room (with synchronize)
const STOP_SUBJECT = "micropython-stop"

let frame = null
// The simulator plays sound, and browsers allow audio only after a click. So the first
// program can only start from the play button on the board: its click sends request_flash.
// After that, programs start right away.
let unlocked = false
// the last program, as { "main.py": "...", ... }; flashed again when play is clicked
let program = null
let running = false
let state = "loading"

// kind is the badge colour: on, off or wait
function setStatus(name, kind) {
    state = name
    const badge = document.getElementById("status")
    badge.textContent = name
    badge.className = "badge " + kind
}

function disabled(bool) {
    document.getElementById("send").disabled = bool
    document.getElementById("stop").disabled = bool
    document.getElementById("stdin").disabled = bool
}

function post(message) {
    frame?.contentWindow.postMessage(message, new URL(board().url).origin)
}

// An upload is Python source, or a project as module-editor's multi-file
// mode sends it: JSON {"file": {"main.py": "...", "util.py": "..."}}.
// All files go onto the board's filesystem; the board runs main.py, so
// without one the first .py file becomes main.py. Returns { files } or { error }.
function parseUpload(body) {
    let project
    try {
        project = JSON.parse(body)
    } catch (e) {
        return { files: { "main.py": String(body) } }
    }
    if (!project || typeof project.file !== "object" || Array.isArray(project.file)) {
        return { files: { "main.py": String(body) } }
    }

    const names = Object.keys(project.file)
    const main = names.includes("main.py") ? "main.py" : names.find((name) => name.endsWith(".py"))
    if (!main) {
        return { error: `the project has no .py file (files: ${names.join(", ") || "none"})` }
    }

    const files = { "main.py": String(project.file[main]) }
    for (const name of names.filter((name) => name !== main)) {
        files[name] = String(project.file[name])
    }
    return { files }
}

function run(body) {
    const { files, error } = parseUpload(body)
    if (error) {
        notice(`\n${error}`, true)
        setStatus("error", "off")
        return
    }

    program = files
    if (unlocked) {
        flash()
    } else {
        clearTerminal()
        notice("Program received: click ▶ on the board to start it (browsers allow sound only after a click).")
        setStatus("press play", "wait")
    }
}

// starts the program from the beginning; without one, the board starts at the >>> prompt
function flash() {
    const encoder = new TextEncoder()
    const filesystem = {}
    for (const [name, content] of Object.entries(program || {})) {
        filesystem[name] = encoder.encode(content)
    }

    clearTerminal()
    post({ kind: "flash", filesystem })
    running = true
    disabled(false)
    setStatus("running", "on")
}

function stop() {
    if (running) {
        post({ kind: "stop" })
        running = false
        disabled(true)
        notice("\nexecution stopped")
        setStatus("stopped", "wait")
    } else if (state === "press play") {
        // a stop before play drops the waiting program
        program = null
        notice("\nexecution stopped")
        setStatus("stopped", "wait")
    }
}

// The stop button: with synchronize, Stop is shared like Run, and the
// stored program is removed so nobody restarts it on reload or join.
function stopClicked() {
    if (config().synchronize === true) {
        Edrys.clearState(programKey())
        // the body names the subject, in case several simulators share a room
        Edrys.sendMessage(STOP_SUBJECT, executeSubject())
    }
    stop()
}

function send() {
    const input = document.getElementById("stdin")

    if (running) {
        // MicroPython echoes what it reads, so the line isn't written to the terminal here;
        // Enter on the board's serial is a carriage return
        post({ kind: "serial_input", data: input.value + "\r" })
    }

    input.value = ""
}

function onSimulator(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(board().url).origin) {
        return
    }
    const data = event.data || {}

    switch (data.kind) {
        case "ready":
            if (state === "loading") {
                setStatus("idle", "wait")
            }
            break
        case "request_flash":
            // the play button was clicked: from now on programs start without it
            unlocked = true
            flash()
            break
        case "serial_output":
            serial(String(data.data))
            break
        case "internal_error":
            notice(`\nsimulator error: ${data.error?.message || data.error}`, true)
            setStatus("error", "off")
            break
    }
}

// ---- terminal --------------------------------------------------------------
//
// Output comes from other peers' programs, so it is only ever added as text,
// never parsed as HTML. The board's serial is a VT100 terminal: MicroPython's
// >>> prompt moves the cursor with \r, \b and escape sequences while it echoes
// and edits a line. So the last line is kept as text with a cursor (shown in
// #line) and only finished lines are appended. Escape sequences other than
// cursor left/right and erase line are dropped.
// Serial output arrives in small chunks, so it is written once per frame. Only
// the newest TERMINAL_LIMIT characters are kept, so a program that prints
// forever doesn't grow the page without limit.
const TERMINAL_LIMIT = 100000
let terminalLength = 0
let pending = ""
let flushScheduled = false
let line = ""
let cursor = 0
// the escape sequence read so far, or null outside of one (it may span chunks)
let escape = null

function serial(data) {
    for (const char of data) {
        if (escape === "") {
            // ESC [ starts a control sequence; other escapes are two characters
            escape = char === "[" ? "[" : null
        } else if (escape !== null) {
            escape += char
            if (char >= "@" && char <= "~") {
                controlSequence(escape.slice(1, -1), char)
                escape = null
            }
        } else if (char === "\x1b") {
            escape = ""
        } else if (char === "\n") {
            pending += line + "\n"
            line = ""
            cursor = 0
        } else if (char === "\r") {
            cursor = 0
        } else if (char === "\b") {
            cursor = Math.max(0, cursor - 1)
        } else if (char >= " " || char === "\t") {
            line = line.slice(0, cursor) + char + line.slice(cursor + 1)
            cursor++
        }
    }

    // a hidden tab gets no frames, so keep the buffer bounded too
    if (pending.length > 2 * TERMINAL_LIMIT) {
        pending = pending.slice(-TERMINAL_LIMIT)
    }
    if (!flushScheduled) {
        flushScheduled = true
        requestAnimationFrame(flushTerminal)
    }
}

function controlSequence(params, command) {
    const n = parseInt(params, 10) || 1
    if (command === "D") {
        cursor = Math.max(0, cursor - n)
    } else if (command === "C") {
        cursor += n
        line = line.padEnd(cursor)
    } else if (command === "K" && (params === "" || params === "0")) {
        line = line.slice(0, cursor)
    }
}

function flushTerminal() {
    flushScheduled = false
    const terminal = document.getElementById("stdout")
    const lineSpan = document.getElementById("line")

    if (pending) {
        terminal.querySelector(".hint")?.remove()
        lineSpan.before(pending)
        terminalLength += pending.length
        pending = ""
        trimTerminal(terminal)
    }
    if (lineSpan.textContent !== line) {
        terminal.querySelector(".hint")?.remove()
        lineSpan.textContent = line
    }
    terminal.scrollTo(0, terminal.scrollHeight)
}

// A message of the module itself, after the output so far, on a line of its own
function notice(text, error = false) {
    if (line) {
        pending += line + "\n"
        line = ""
        cursor = 0
    }
    flushTerminal()

    const span = document.createElement("span")
    if (error) {
        span.className = "error"
    }
    span.textContent = text + "\n"
    document.getElementById("line").before(span)
    terminalLength += span.textContent.length
    trimTerminal(document.getElementById("stdout"))
    document.getElementById("stdout").scrollTo(0, document.getElementById("stdout").scrollHeight)
}

function clearTerminal() {
    const lineSpan = document.getElementById("line")
    lineSpan.textContent = ""
    document.getElementById("stdout").replaceChildren(lineSpan)
    terminalLength = 0
    pending = ""
    line = ""
    cursor = 0
    escape = null
}

// drop the oldest output beyond TERMINAL_LIMIT characters (the current line stays)
function trimTerminal(terminal) {
    let excess = terminalLength - TERMINAL_LIMIT

    while (excess > 0 && terminal.firstChild && terminal.firstChild.id !== "line") {
        const node = terminal.firstChild
        const length = node.textContent.length

        if (length <= excess) {
            node.remove()
            terminalLength -= length
            excess -= length
        } else {
            if (node.nodeType === Node.TEXT_NODE) {
                node.deleteData(0, excess)
            } else {
                node.textContent = node.textContent.slice(excess)
            }
            terminalLength -= excess
            excess = 0
        }
    }
}

// ---- Edrys -----------------------------------------------------------------

Edrys.onReady(() => {
    console.log("MicroPython simulator loaded ...")

    document.getElementById("stdout").querySelector(".hint")?.replaceChildren(
        "Waiting for code from an editor module (subject ",
        Object.assign(document.createElement("code"), { textContent: executeSubject() }),
        "). Programs for the " + board().name + " start with ",
        Object.assign(document.createElement("code"), { textContent: board().import }),
        "."
    )

    document.getElementById("stdin").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            send()
        }
    })
    document.getElementById("send").addEventListener("click", send)
    document.getElementById("stop").addEventListener("click", stopClicked)

    window.addEventListener("message", onSimulator)
    // created only now: edrys.js trusts the origin of the first message it receives,
    // which has to be edrys-Lite's, not the simulator's
    frame = document.createElement("iframe")
    frame.title = board().name + " simulator"
    frame.sandbox = "allow-scripts allow-same-origin"
    frame.src = board().url
    document.getElementById("board").style.setProperty("--ratio", board().ratio)
    document.getElementById("board").append(frame)

    // with synchronize, pick up the program the room is running (it starts from the beginning)
    if (config().synchronize === true) {
        const stored = Edrys.getState(programKey(), "Value")

        if (stored) {
            run(stored)
        }
    }
})

Edrys.onMessage(
    ({
        from,
        subject,
        body,
        module
    }) => {
        if (subject === executeSubject()) {
            // without synchronize, only run code this peer sent itself
            if (config().synchronize !== true && from !== Edrys.username) {
                return
            }

            // the sender keeps the upload in the room for peers who join or reload later
            if (config().synchronize === true && from === Edrys.username) {
                Edrys.getState(programKey(), "Value", body)
            }

            run(body)
        } else if (
            subject === STOP_SUBJECT &&
            module === Edrys.module.url &&
            body === executeSubject() &&
            config().synchronize === true &&
            from !== Edrys.username // the sender stopped already
        ) {
            stop()
        }
    },
    // promiscuous: also receive messages sent by other modules (the editor)
    true)
