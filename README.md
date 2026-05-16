### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Setup

Create a `.env` file in the root of the project and add your Google Maps API Key:
```env
VITE_GOOGLE_MAPS_KEY=YourActualKeyHere
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
