# Technical Documentation: Custom Routing Logic

This document explains the core logic behind the interactive routing system implemented in this Mapbox application.

## Overview

Map APIs (like Google Maps or Mapbox) natively route using real-world public road networks. To route users along a *custom* network (e.g., private trails, indoor mall paths, or a video game grid), we must separate the visual map rendering from the mathematical routing logic. 

Our application achieves this using a combination of **Mapbox GL JS** (for rendering), **Turf.js** (for geospatial snapping), and **geojson-path-finder** (for mathematical graph routing).

---

## 1. Turf.js (The "Snapper")

**The Problem:** Mapbox records a mouse click as a highly precise Longitude/Latitude coordinate. However, custom routing engines require exact coordinates that exist on the predefined path network. If a user clicks even slightly off a path, the routing engine cannot process the request.

**The Solution:** Turf.js acts as a geospatial magnet to correct user input.

1. **Initialization:** On load, the application extracts every intersection (vertex) from `paths.json` to create a "Point Cloud" of valid nodes.
2. **User Interaction:** The user clicks the map (e.g., `[-122.0845, 37.4225]`).
3. **Calculation:** The application runs `turf.nearestPoint(clickedPoint, networkPoints)`. Turf calculates the straight-line geometric distance from the exact click coordinate to every intersection in the Point Cloud.
4. **Snapping:** Turf returns the mathematically closest valid intersection. The application ignores the raw mouse click and places the marker exactly on that valid intersection.

---

## 2. geojson-path-finder (The "Navigator")

**The Problem:** The custom network in `paths.json` is a collection of disconnected line segments (`LineStrings`). It lacks the inherent logic to navigate from one arbitrary line to another.

**The Solution:** `geojson-path-finder` converts the raw lines into a traversable mathematical graph.

1. **Building the Graph:** Upon initialization (`new PathFinder(customNetwork)`), the library analyzes the GeoJSON file. It identifies which lines intersect (share identical coordinates) and calculates the exact geographic length ("Weight") of every segment. This converts the raw lines into a network of **Nodes** (intersections) and **Edges** (connecting paths).
2. **Execution:** The application provides the library with the snapped Start Node and End Node.
3. **The Algorithm:** Under the hood, the library utilizes **Dijkstra's Algorithm**. It explores outward from the Start Node, traversing Edges and accumulating Weights. It continuously prioritizes exploring the shortest possible paths until it successfully reaches the End Node.
4. **Rendering:** The library returns a single, continuous GeoJSON `LineString` representing the absolute shortest path. Mapbox then renders this output as a highlighted route on the map.
