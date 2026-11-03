"""Capture assets/hero.png from the running HUD driven by the mock backend.

Usage:
    npm run build
    node bin/jarvis-hud.mjs mock --port 8787 &
    python scripts/screenshot.py --url http://127.0.0.1:8787 --out assets/hero.png

Everything in the screenshot is real: the HUD sends these prompts over the
WebSocket, the mock backend runs the real local tools, and the frame is taken
while the assistant is streaming its answer.
"""
import argparse
import time

from playwright.sync_api import sync_playwright

PROMPTS = [
    "Run a quick system diagnostic",
    "What time is it in Dubai?",
    "Remember that the investor demo is Thursday at 10",
    "What is 4250 * 0.18 + 1299?",
]
FINAL = "What time is it in Tokyo, and what is 1299 * 3.67?"


def wait_idle(page, timeout=20):
    end = time.time() + timeout
    time.sleep(0.4)
    while time.time() < end:
        if page.evaluate("window.__jarvis.state.assistant") == "idle":
            return
        time.sleep(0.1)
    raise RuntimeError("assistant never returned to idle")


def send(page, text):
    page.fill("#prompt", text)
    page.press("#prompt", "Enter")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8787")
    ap.add_argument("--out", default="assets/hero.png")
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--scale", type=float, default=1)
    ap.add_argument("--progress", type=float, default=0.62, help="fraction of the final answer streamed")
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={"width": args.width, "height": args.height}, device_scale_factor=args.scale
        )
        page.goto(args.url)
        page.wait_for_function("window.__jarvis && window.__jarvis.state.connection === 'open' && window.__jarvis.state.meta")
        page.evaluate("document.fonts.ready")
        for text in PROMPTS:
            send(page, text)
            wait_idle(page)
        send(page, FINAL)
        page.wait_for_function("window.__jarvis.state.assistant === 'speaking'", timeout=15000)
        # Let the answer stream until the requested fraction is visible.
        page.wait_for_function(
            """(f) => {
              const t = window.__jarvis.state.transcript.filter(u => u.role === 'assistant').pop();
              return t && t.text.split(' ').length >= f;
            }""",
            arg=int(args.progress * 22),
            timeout=15000,
        )
        page.screenshot(path=args.out)
        browser.close()
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
