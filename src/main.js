const apiKey = import.meta.env.VITE_GOOGLE_MAPS_KEY;

if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
  console.warn("Please add your Google Maps API Key to the .env file.");
} else {
  // Dynamically create the Google Maps script tag
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap`;
  script.async = true;
  document.head.appendChild(script);
}

// Make initMap globally available for the callback
window.initMap = function() {
  const location = { lat: 37.422, lng: -122.084 };
  const mapElement = document.getElementById("map");
  
  if (mapElement) {
    const map = new google.maps.Map(mapElement, {
      zoom: 14,
      center: location,
    });
  
    new google.maps.Marker({
      position: location,
      map: map,
    });
  }
};
