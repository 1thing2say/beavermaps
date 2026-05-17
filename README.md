# Custom Map Router

This project is a custom interactive routing application built with Vite, Tailwind CSS, Mapbox GL JS, Turf.js, and geojson-path-finder.

## Features
*   **Custom Network Routing:** Calculates the shortest path across a user-defined grid instead of public roads.
*   **Interactive UI:** Click on the map to set Start and End points, with a floating UI displaying live coordinates and distance.
*   **Intelligent Snapping:** Mouse clicks automatically snap to the nearest valid intersection using geospatial math.

📚 **[Read the Technical Documentation for routing logic details](TECHNICAL_DOCS.md)**

---

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Setup

Create a `.env` file in the root of the project and add your Mapbox Access Token:
```env
VITE_MAPBOX_TOKEN=YourActualTokenHere
```

### 3. Development

**To start the local development server (with Hot Module Replacement):**
This command will start a local server (usually on `http://localhost:5173`) and automatically update the browser whenever you save your HTML, CSS, or JS files.
```bash
npm run dev
```

### 4. Production Build

**To build the optimized application for production:**
```bash
npm run build
```
This will create a `dist` folder containing the final HTML, CSS, and JS files ready to be hosted.
**To preview the production build locally:**
```bash
npm run preview
```
