// The simulators are MicroPython compiled to WebAssembly, made to be embedded as an iframe.
// Both speak the same message API (see README). They are copies of the hosted ones, patched
// to start without their play button (scripts/update-simulators.sh). ratio is height / width
// of the board drawing (the viewBox of the simulator's SVG), to size the frame to it.
const BOARDS = {
    "calliope-mini-3": {
        name: "Calliope mini 3",
        path: "simulators/calliope-mini-3/simulator.html",
        import: "from calliopemini import *",
        ratio: 219.4 / 243.7,
    },
    "microbit-v2": {
        name: "BBC micro:bit v2",
        path: "simulators/microbit-v2/simulator.html",
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
// whether the simulator has loaded (sent ready); a program sent before waits for it
let simulatorReady = false
// the last program, as { "main.py": "...", ... }; flashed again when the board's play
// button is clicked after Stop
let program = null
let running = false

// kind is the badge colour: on, off or wait
function setStatus(name, kind) {
    const badge = document.getElementById("status")
    badge.textContent = name
    badge.className = "badge " + kind
}

function disabled(bool) {
    document.getElementById("send").disabled = bool
    document.getElementById("stop").disabled = bool
    document.getElementById("stdin").disabled = bool
}

// The simulator is served next to the module, so it has the module's origin. It keeps that
// origin in its sandbox (allow-same-origin): with an opaque one, its fetch of firmware.wasm
// would be cross-origin and fail on servers without CORS headers (like VS Code's Live Server).
function post(message) {
    frame?.contentWindow.postMessage(message, location.origin)
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
    if (simulatorReady) {
        flash()
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
    } else if (!simulatorReady) {
        // a stop while the board loads drops the program waiting for it
        program = null
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
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) {
        return
    }
    const data = event.data || {}

    switch (data.kind) {
        case "ready":
            simulatorReady = true
            createSensors(data.state || {})
            if (program) {
                flash()
            } else {
                setStatus("idle", "wait")
            }
            break
        case "request_flash":
            // the board's play button, shown before the first program and after Stop
            flash()
            break
        case "state_change":
            updateSensors(data.change || {})
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

// ---- sensors ---------------------------------------------------------------
//
// Controls below the board for the board's sensors, as config.sensors lists them:
// simulator ids with an optional range, e.g. "temperature:0:40, lightLevel, gesture",
// or "all". The simulator describes its sensors in ready (and changes, e.g. after
// accelerometer.set_range, in state_change): ranges as { type: "range", min, max,
// value, unit }, choices as { type: "enum", choices, value }. The controls are
// built from that and set values with set_value. The board keeps the values when a
// new program starts. They are local: each peer sets its own, like pressing a button.

const SENSOR_LABELS = {
    temperature: "Temperature",
    lightLevel: "Light level",
    soundLevel: "Sound level",
    accelerometerX: "Acceleration X",
    accelerometerY: "Acceleration Y",
    accelerometerZ: "Acceleration Z",
    gesture: "Gesture",
    compassHeading: "Compass heading",
    compassX: "Magnetic field X",
    compassY: "Magnetic field Y",
    compassZ: "Magnetic field Z",
}
const SENSOR_UNITS = { deg: "°" }
// buttons and pins are clicked on the board itself
const ON_BOARD = /^(button[AB]|pin\w+)$/

// id -> { sensor, range, input, output }; range is the one from the config, or null
let controls = {}

const isSensor = (sensor) => sensor?.type === "range" || sensor?.type === "enum"

// the sensors config.sensors asks for, as Map id -> range ({ min, max } or null)
function requestedSensors(state) {
    const requested = new Map()
    const spec = typeof config().sensors === "string" ? config().sensors : ""
    const ids = Object.keys(state).filter((id) => isSensor(state[id]) && !ON_BOARD.test(id))

    for (const entry of spec.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        const [name, min, max, ...rest] = entry.split(":").map((part) => part.trim())
        if (name === "none") {
            continue
        }
        if (name === "all" && min === undefined) {
            ids.filter((id) => !requested.has(id)).forEach((id) => requested.set(id, null))
            continue
        }

        const id = Object.keys(state).find((id) => id.toLowerCase() === name.toLowerCase())
        const sensor = state[id]
        if (!isSensor(sensor)) {
            console.warn(`MicroPython: unknown sensor in sensors="${entry}" (sensors: ${ids.join(", ")})`)
            continue
        }
        if (ON_BOARD.test(id)) {
            console.warn(`MicroPython: ${id} is clicked on the board, it has no control`)
            continue
        }
        if (min === undefined) {
            requested.set(id, null)
            continue
        }

        const range = { min: Number(min), max: Number(max) }
        if (
            sensor.type !== "range" || max === undefined || rest.length ||
            isNaN(range.min) || isNaN(range.max) || range.min >= range.max ||
            range.min < sensor.min || range.max > sensor.max
        ) {
            console.warn(
                sensor.type === "range"
                    ? `MicroPython: invalid range in sensors="${entry}" (${id}: ${sensor.min} to ${sensor.max})`
                    : `MicroPython: ${id} has choices, no range (sensors="${entry}")`
            )
            continue
        }
        requested.set(id, range)
    }
    return requested
}

function createSensors(state) {
    const parent = document.getElementById("sensors")
    parent.replaceChildren()
    controls = {}

    for (const [id, range] of requestedSensors(state)) {
        const control = { sensor: state[id], range }
        const container = document.createElement("label")
        container.className = "slider"
        container.dataset.sensor = id
        const label = document.createElement("span")
        label.textContent = SENSOR_LABELS[id] || id

        if (control.sensor.type === "enum") {
            control.input = document.createElement("select")
            for (const choice of control.sensor.choices) {
                control.input.append(new Option(choice, choice))
            }
            control.input.addEventListener("change", () => post({ kind: "set_value", id, value: control.input.value }))
            container.append(label, control.input)
        } else {
            control.input = document.createElement("input")
            control.input.type = "range"
            control.input.step = "1"
            control.output = document.createElement("output")
            control.input.addEventListener("input", () => {
                showSensor(control)
                post({ kind: "set_value", id, value: Number(control.input.value) })
            })
            container.append(label, control.input, control.output)
        }

        controls[id] = control
        parent.append(container)
        setSensor(control, control.sensor)
    }
}

// the simulator's sensor changed: its value, or its range (accelerometer.set_range)
function updateSensors(change) {
    for (const [id, sensor] of Object.entries(change)) {
        if (controls[id] && isSensor(sensor)) {
            setSensor(controls[id], sensor)
        }
    }
}

function setSensor(control, sensor) {
    control.sensor = sensor
    if (sensor.type === "enum") {
        control.input.value = sensor.value
        return
    }

    // the range from the config, within what the simulator allows now
    let min = Math.max(control.range?.min ?? sensor.min, sensor.min)
    let max = Math.min(control.range?.max ?? sensor.max, sensor.max)
    if (min >= max) {
        min = sensor.min
        max = sensor.max
    }
    control.input.min = String(min)
    control.input.max = String(max)
    control.input.value = String(sensor.value)
    showSensor(control)

    // outside of the slider's range: the board gets the nearest value the slider can show
    const value = Math.min(max, Math.max(min, sensor.value))
    if (value !== sensor.value) {
        post({ kind: "set_value", id: sensor.id, value })
    }
}

function showSensor(control) {
    const unit = control.sensor.unit ? SENSOR_UNITS[control.sensor.unit] || " " + control.sensor.unit : ""
    control.output.textContent = control.input.value + unit
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
    frame.src = board().path
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
