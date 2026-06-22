<div align="right">

[English](README.md) | [简体中文](README_CN.md)

</div>

# Web Request Trace

A Chrome extension (Manifest V3) for debugging backend API calls in admin management systems.

Click any element on the page to pinpoint which backend API response contains its data — a daily essential for front-end developers working with complex admin panels.

## Features

### Data Tracing

Click on page data (e.g., a user name, order number, or status label), and the extension automatically:

- Searches through all captured API response bodies
- Matches the clicked element's text content against response data
- Ranks and displays the most likely API endpoints
- Highlights the matching text snippet in the response body

Supports both `fetch` and `XMLHttpRequest` — no configuration needed.

### Request Probing

Before submitting a form, toggle **Probe Mode**, then click the submit button. The extension intercepts and **blocks** the outgoing request, displaying:

- Request method and URL
- Request headers
- Request body (form data, JSON, etc.)

The request never reaches the server — perfect for inspecting what parameters a button actually sends without side effects.

### Global Toggle

Click the extension icon to toggle the feature on/off across all tabs. An "ON" badge appears when active.

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project directory
5. The extension icon appears in the toolbar

## Usage

### Trace data to its API source

1. Click the extension icon to enable (badge shows **ON**)
2. A **🔎 Data Tracing** floating button appears bottom-right
3. Click it to enter selection mode
4. Click any data element on the page — a panel shows matching APIs
5. Click an API path to copy `METHOD /path?query` to clipboard
6. Expand an item to see the matched response snippet
7. Press **Esc** to exit selection mode

### Probe which API a button calls

1. Enable the extension (badge shows **ON**)
2. Click the **🎯 Request Probing** floating button
3. A tip appears: "Probe ready — click a button to intercept its request"
4. Click any button / form submit
5. A panel shows the intercepted request details
6. Requests are **blocked** — refresh the page to restore normal behavior

### Manual search

In the tracing panel, you can also type any text into the search box and press Enter to find which API responses contain that text.

## How It Works

- **`background.js`** — Service worker managing the global on/off toggle, persists state via `storage.local`, broadcasts changes to all tabs
- **`content-script.js`** — Bridge between the extension and page context; injects `inject.js` into the page, relays the enabled state
- **`inject.js`** — The core runtime injected into the page's JavaScript context. Hooks `fetch` and `XMLHttpRequest` to capture responses, implements the element-to-API matching algorithm, and renders the Shadow DOM UI overlay

The tracing algorithm:

1. Extracts meaningful tokens from the selected element's text (CJK words, alphanumeric values)
2. Filters out noise (common UI labels, generic terms like "edit", "delete")
3. Scores each captured API response by how many tokens it contains
4. Returns results sorted by relevance score

## Privacy

All API response data stays **local** in the browser tab's memory. No data is sent to any server. The extension requires `storage` permission only for the on/off toggle state.

## License

MIT
