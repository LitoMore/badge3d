# Badge3D

Badge3D is a Vite React SPA that turns shields.io SVG badges into
configurable 3D-printable models. SVG parsing, 3D previewing, and 3MF/STL export
run in the browser, including fetching badges directly from shields.io.

## Requirements

- Node.js `>=22.13.0`

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and paste a secure shields.io badge URL.

The initial sample model is bundled, so the workbench remains usable when
shields.io is temporarily unavailable.

## Commands

- `npm run dev`: start the local development server
- `npm run build`: create a production build
- `npm run preview`: preview the production build locally
- `npm run deploy`: build and deploy the static SPA to Cloudflare Pages with Wrangler
- `npm run lint`: run ESLint
- `npm run typecheck`: run TypeScript without emitting files

## Export formats

- Multicolor 3MF: aligned color parts with base-material metadata
- Single-color STL: one universal mesh for single-material printing
- Color STL ZIP: one aligned STL per source color for manual extruder assignment

## Project layout

- `src/BadgeWorkshop.tsx`: SVG parsing, 3D model generation, preview, and 3MF/STL export
- `src/globals.css`: product UI styles
- `src/main.tsx`: React SPA entry point
- `vite.config.ts`: React and Sites Vite configuration
- `wrangler.jsonc`: Cloudflare static asset deployment configuration
