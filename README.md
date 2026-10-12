# Edrys MicroPython Simulator Module

A MicroPython simulator for [edrys-Lite](https://github.com/edrys-labs/edrys-Lite). It runs Python programs on a
simulated **Calliope mini 3** or **BBC micro:bit v2** in the browser and shows the serial output (`print`,
tracebacks) in a terminal, with no hardware required. The simulated board has working LEDs, buttons, pins and sound.

Import the module via:

```
https://edrys-labs.github.io/module-micropython-simulator/index.html
```

It needs an editor module that sends Python code, such as
[module-monaco-editor](https://github.com/edrys-labs/module-monaco-editor) (with `runCommand: execute`).

**Simulators:** the module embeds the simulators the Calliope and micro:bit Python editors use, from their hosted
sites (`simulator.python.calliope.cc`, `python-simulator.usermbit.org`). The module needs internet access. The
programs run in the browser: no code is sent to a server. Both simulators describe their embedding API as not yet
stable, so a change on their side can break the module.

---

## Configuration

| Property      | Type    | Description                                                        | Default             |
|---------------|---------|--------------------------------------------------------------------|---------------------|
| `board`       | String  | `calliope-mini-3` or `microbit-v2`                                 | `"calliope-mini-3"` |
| `execute`     | String  | Edrys message subject the module runs code from                    | `"execute"`         |
| `synchronize` | Boolean | Run code sent by any peer in the room on every peer in that room   | `false`             |

Programs import the board's module: `from calliopemini import *` on the Calliope mini 3,
`from microbit import *` on the micro:bit. The Calliope mini 1 and 2 have no MicroPython simulator.

By default, each peer runs only the code it sent itself. With `synchronize: true`, a program from anyone in the
room starts on every peer in the room (each peer runs its own simulation, so button presses stay local). The last
program is kept in the room state under `micropython:<execute>` (e.g. `micropython:execute`), so peers who join
later or reload get it too. Stop is shared the same way: it stops every peer and removes the stored program.

**YAML example:**

```yaml
board: calliope-mini-3
execute: execute
synchronize: false
```

**JSON example:**

```json
{
  "board": "microbit-v2",
  "execute": "execute",
  "synchronize": false
}
```

---

## Using the Module

- **Header:** the status badge shows `idle`, `press play`, `running`, `stopped` or `error`. **Stop** (red while a
  program runs) stops the board.
- **Board:** click the board's buttons and pins as on the real one.
- **Play button:** browsers allow sound only after a click, so the **first** program waits until you click ▶ on
  the board (status `press play`). Later programs start right away. After Stop, ▶ runs the last program again from
  the beginning.
- **Terminal:** the serial output. A new program clears it. Only the newest 100,000 characters are kept.
- **Input:** type a line and press Enter or **Send**. It is sent with a carriage return, as Enter on the board's
  serial, so `input()` reads it. MicroPython echoes what it reads.
- **`>>>` prompt:** when the program has ended, the board starts MicroPython's prompt, and lines sent from the
  input run there (`6*7` → `42`). After an error, the board first scrolls the error over its display.

### Example: serial input

The program asks for a command, reads the line sent from the input field with `input()`, and shows an image on
the LEDs (on the micro:bit, import `microbit` instead of `calliopemini`):

```python
from calliopemini import *

while True:
    command = input("command (heart, happy, clear)? ")
    if command == "heart":
        display.show(Image.HEART)
    elif command == "happy":
        display.show(Image.HAPPY)
    elif command == "clear":
        display.clear()
    else:
        print("unknown command:", command)
```

Sending `heart`, then `hello` from the input field shows a heart on the board, and the terminal shows:

```
command (heart, happy, clear)? heart
command (heart, happy, clear)? hello
unknown command: hello
command (heart, happy, clear)? 
```

### Code format

The module accepts plain Python, or a project as [module-editor](https://github.com/edrys-labs/module-editor)'s
multi-file mode sends it:

```json
{ "file": { "main.py": "import util\nprint(util.twice(21))", "util.py": "def twice(x):\n    return 2 * x" } }
```

All files go onto the board's filesystem and `main.py` runs. Without a `main.py`, the first `.py` file becomes
`main.py`.

---

## Tests

End-to-end tests run the module in a real edrys-Lite, see
[edrys-module-tests](https://github.com/edrys-labs/edrys-module-tests) (`modules/module-micropython-simulator`). They use the hosted
simulators, so they need internet access.

---

## Credits

- [micropython-microbit-v2-simulator](https://github.com/microbit-foundation/micropython-microbit-v2-simulator)
  by the Micro:bit Educational Foundation (MIT)
- [micropython-simulator](https://github.com/calliope-edu/micropython-simulator) by Calliope gGmbH, a fork of the
  micro:bit simulator (MIT)
- [MicroPython](https://micropython.org) (MIT)

---

## License

[MIT](LICENSE) © edrys-labs
