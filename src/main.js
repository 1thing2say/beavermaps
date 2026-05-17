import mapboxgl from 'mapbox-gl';
import PathFinder from 'geojson-path-finder';
import * as turf from '@turf/turf';
import customNetwork from './paths.json';

const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

if (!accessToken || accessToken === 'YOUR_MAPBOX_TOKEN_HERE') {
  console.warn("Please add your Mapbox Access Token to the .env file as VITE_MAPBOX_TOKEN.");
} else {
  mapboxgl.accessToken = accessToken;
  
  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [-122.084, 37.422],
    zoom: 15, 
  });

  // Extract all unique vertices from our network so we can snap clicks to them
  const vertices = [];
  customNetwork.features.forEach(feature => {
    feature.geometry.coordinates.forEach(coord => {
      if (!vertices.some(v => v[0] === coord[0] && v[1] === coord[1])) {
        vertices.push(coord);
      }
    });
  });
  const networkPoints = turf.featureCollection(vertices.map(v => turf.point(v)));

  // Initialize the routing math engine
  const pathFinder = new PathFinder(customNetwork);

  // State variables
  let startMarker = null;
  let endMarker = null;
  let startPoint = null;
  let endPoint = null;

  // GUI Elements
  const instructionText = document.getElementById('instruction-text');
  const startCoordText = document.getElementById('start-coord');
  const endCoordText = document.getElementById('end-coord');
  const distanceText = document.getElementById('distance-text');
  const clearBtn = document.getElementById('clear-btn');

  function resetMap() {
    if (startMarker) startMarker.remove();
    if (endMarker) endMarker.remove();
    startPoint = null;
    endPoint = null;
    startMarker = null;
    endMarker = null;
    
    if (map.getSource('calculated-route')) {
      map.getSource('calculated-route').setData({ type: 'FeatureCollection', features: [] });
    }
    
    // Reset UI
    instructionText.textContent = "Click on the map to set a start point.";
    startCoordText.textContent = "Not set";
    endCoordText.textContent = "Not set";
    distanceText.innerHTML = '0.00 <span class="text-lg text-gray-500 font-medium">units</span>';
  }

  clearBtn.addEventListener('click', resetMap);

  map.on('load', () => {
    map.addSource('custom-network', {
      type: 'geojson',
      data: customNetwork
    });

    map.addLayer({
      id: 'network-lines',
      type: 'line',
      source: 'custom-network',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#555555', 'line-width': 2, 'line-dasharray': [2, 2] }
    });

    map.addSource('calculated-route', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'calculated-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#00ffcc', 'line-width': 6 }
    });

    map.on('click', (e) => {
      const clickedPoint = turf.point([e.lngLat.lng, e.lngLat.lat]);
      const snappedPoint = turf.nearestPoint(clickedPoint, networkPoints);
      const snappedCoords = snappedPoint.geometry.coordinates;
      const formattedCoords = `${snappedCoords[1].toFixed(4)}, ${snappedCoords[0].toFixed(4)}`;

      // Clear map if both points are already set and user clicks again
      if (startPoint && endPoint) {
        resetMap();
      }

      if (!startPoint) {
        startPoint = snappedPoint;
        startMarker = new mapboxgl.Marker({ color: '#22c55e' }) // Tailwind green-500
          .setLngLat(snappedCoords)
          .addTo(map);
        
        startCoordText.textContent = formattedCoords;
        instructionText.textContent = "Great! Now click to set an end point.";
      } else {
        endPoint = snappedPoint;
        endMarker = new mapboxgl.Marker({ color: '#ef4444' }) // Tailwind red-500
          .setLngLat(snappedCoords)
          .addTo(map);
          
        endCoordText.textContent = formattedCoords;
        instructionText.textContent = "Route calculated!";

        const route = pathFinder.findPath(startPoint, endPoint);

        if (route) {
          map.getSource('calculated-route').setData({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: route.path }
          });
          
          distanceText.innerHTML = `${route.weight.toFixed(2)} <span class="text-lg text-gray-500 font-medium">units</span>`;
        } else {
          instructionText.textContent = "Error: No path found.";
          distanceText.innerHTML = 'N/A';
          endPoint = null;
          endMarker.remove();
        }
      }
    });

    map.getCanvas().style.cursor = 'crosshair';
  });
}
