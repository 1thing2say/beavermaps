import mapboxgl from 'mapbox-gl';

const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

if (!accessToken || accessToken === 'YOUR_MAPBOX_TOKEN_HERE') {
  console.warn("Please add your Mapbox Access Token to the .env file as VITE_MAPBOX_TOKEN.");
} else {
  mapboxgl.accessToken = accessToken;
  
  const map = new mapboxgl.Map({
    container: 'map', // ID of the div element
    style: 'mapbox://styles/mapbox/streets-v12', // style URL
    center: [-122.084, 37.422], // starting position [lng, lat]
    zoom: 14, // starting zoom
  });

  // Add a simple marker to start
  new mapboxgl.Marker()
    .setLngLat([-122.084, 37.422])
    .addTo(map);
}
