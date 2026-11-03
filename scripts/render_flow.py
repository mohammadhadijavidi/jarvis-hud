"""Render scripts/flow.html (hand-drawn SVG diagram) to assets/flow.png. Run after npm install (uses bundled fonts)."""
import pathlib

from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    page.goto((root / "scripts" / "flow.html").as_uri())
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)
    page.screenshot(path=str(root / "assets" / "flow.png"))
    browser.close()
print("wrote assets/flow.png")
