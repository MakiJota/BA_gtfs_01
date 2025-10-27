
// Global data variables
let city_limit, stops, routes, shapes, trips, stopTimes;
let lonMin, lonMax, latMin, latMax;
let subteColors; 
let titleText;

// UI elements (for future implementation)
let buttonBA, buttonNYC, buttonCDMX, buttonBE;

// Cached data for performance
let routeToLineCache = {};
let tripToRouteCache = {};
let stopToRouteCache = {};

// ================== CONFIG ==================
const SUPPORTED_CITIES = ["NYC", "BA", "CDMX", "BE", "SDC"];
let city = "BA"; // Current active city

// Active config
let cfg = null;
// zoom/pan vars
let zoom = 1;
let offsetX = 0, offsetY = 0;
let dragging = false;
let lastX, lastY;

// store comuna fill colors (avoid flashing)
let comunaColors = [];



// ========== VAGONS ==========
let shapePaths = {};  // shape_id → array of {x, y, seq}
let vagons = [];      // each vagon: {shape_id, pos, speed, color}

// ========== UTILITY FUNCTIONS ==========
function getLineLetterFromShape(shape_id, cityType) {
  if (cityType === "BA" || cityType === "NYC" || cityType === "BE") {
    return shape_id.charAt(0);
  } else if (cityType === "CDMX" || cityType === "SDC") {
    return shape_id;
  }
  return shape_id.charAt(0); // fallback
}

function mapCoordinates(lon, lat) {
  return {
    x: map(lon, lonMin, lonMax, 50, width - 50),
    y: map(lat, latMin, latMax, height - 50, 50)
  };
}

function validateConfig(config) {
  const required = ['folder', 'lonMin', 'lonMax', 'latMin', 'latMax', 'title', 'colors'];
  for (let field of required) {
    if (!(field in config)) {
      throw new Error(`Missing required config field: ${field}`);
    }
  }
  return true;
}

function preload() {
  console.log(`Loading assets/${city}/config.json`);

  try {
    cfg = loadJSON(`assets/${city}/config.json`, (data) => {
      console.log("Config loaded:", data);
      
      try {
        validateConfig(data);
        cfg = data;

        // Load dependent files
        city_limit = loadJSON(cfg.folder + 'limit.geojson');
        stops      = loadTable(cfg.folder + 'GTFS/stops.txt', 'csv', 'header');
        routes     = loadTable(cfg.folder + 'GTFS/routes.txt', 'csv', 'header');
        shapes     = loadTable(cfg.folder + 'GTFS/shapes.txt', 'csv', 'header');
        trips      = loadTable(cfg.folder + 'GTFS/trips.txt', 'csv', 'header');
        stopTimes  = loadTable(cfg.folder + 'GTFS/stop_times.txt', 'csv', 'header');
      } catch (error) {
        console.error("Config validation failed:", error);
      }
    }, (error) => {
      console.error("Failed to load config:", error);
    });
  } catch (error) {
    console.error("Error in preload:", error);
  }
}


function setup() {
  createCanvas(1200, 1200);
  console.log("Setup complete for " + city);

  // Wait for config to load
  if (!cfg) {
    console.warn("Config not loaded yet, retrying in next frame");
    return;
  }

  // Initialize config values
  lonMin = cfg.lonMin;
  lonMax = cfg.lonMax;
  latMin = cfg.latMin;
  latMax = cfg.latMax;
  subteColors = cfg.colors;
  titleText = cfg.title;

  // Initialize comuna colors
  initializeComunaColors();
  
  // Build lookup tables for performance
  buildDataCaches();
  
  // Prepare visualization data
  prepareShapePaths();
  setupVagons();
}

function initializeComunaColors() {
  if (city_limit && city_limit.features) {
    comunaColors = [];
    for (let i = 0; i < city_limit.features.length; i++) {
      comunaColors[i] = color(random(180, 230), 200);
    }
  }
}

function buildDataCaches() {
  if (!routes || !trips || !stopTimes) return;
  
  // Cache route_id → route_short_name mapping
  routeToLineCache = {};
  for (let r = 0; r < routes.getRowCount(); r++) {
    let route_id = routes.getString(r, 'route_id');
    let route_short_name = routes.getString(r, 'route_short_name'); 
    routeToLineCache[route_id] = route_short_name;
  }

  // Cache trip_id → route_id mapping
  tripToRouteCache = {};
  for (let r = 0; r < trips.getRowCount(); r++) {
    tripToRouteCache[trips.getString(r, 'trip_id')] = trips.getString(r, 'route_id');
  }

  // Cache stop_id → route_id mapping
  stopToRouteCache = {};
  for (let r = 0; r < stopTimes.getRowCount(); r++) {
    let stop_id = stopTimes.getString(r, 'stop_id');
    let trip_id = stopTimes.getString(r, 'trip_id');
    let route_id = tripToRouteCache[trip_id];
    if (route_id && !stopToRouteCache[stop_id]) {
      stopToRouteCache[stop_id] = route_id;
    }
  }
  
  console.log("Data caches built successfully");
}

// ========== DRAW LOOP ==========
function draw() {
  background(240);

  // Draw title
  noStroke();
  fill(0);
  textSize(24);
  textAlign(LEFT, TOP);
  text(titleText, 10, 10);

  // Apply zoom/pan
  translate(width/2 + offsetX, height/2 + offsetY);
  scale(zoom);
  translate(-width/2, -height/2);

  drawComunas();
  drawSubteRoutes();
  drawStops();
  drawVagons();
}


// ========== DRAWING FUNCTIONS ==========
function drawComunas() {
  if (!city_limit) return;

  noStroke();
  for (let f = 0; f < city_limit.features.length; f++) {
    let feature = city_limit.features[f];
    let geom = feature.geometry;
    fill(comunaColors[f]);

    if (!geom) continue;

    if (geom.type === "Polygon") {
      drawPolygon(geom.coordinates);
    } else if (geom.type === "MultiPolygon") {
      for (let p = 0; p < geom.coordinates.length; p++) {
        drawPolygon(geom.coordinates[p]);
      }
    }
  }
}

function drawPolygon(coords) {
  for (let r = 0; r < coords.length; r++) {
    beginShape();
    for (let i = 0; i < coords[r].length; i++) {
      let lon = coords[r][i][0];
      let lat = coords[r][i][1];
      let mapped = mapCoordinates(lon, lat);
      vertex(mapped.x, mapped.y);
    }
    endShape(CLOSE);
  }
}

// Cache for processed shapes (avoid reprocessing every frame)
let processedShapes = null;

function drawSubteRoutes() {
  if (!shapes) return;

  // Process shapes only once
  if (!processedShapes) {
    processedShapes = processShapesData();
  }

  strokeWeight(3);
  noFill();

  // Draw each processed shape
  for (let shape_id in processedShapes) {
    let pts = processedShapes[shape_id];
    let lineLetter = getLineLetterFromShape(shape_id, city);
    
    stroke(subteColors[lineLetter] || 'black');

    beginShape();
    for (let pt of pts) {
      vertex(pt.x, pt.y);
    }
    endShape();
  }
}

function processShapesData() {
  let shapesById = {};
  
  for (let r = 0; r < shapes.getRowCount(); r++) {
    let shape_id = shapes.getString(r, 'shape_id');
    let lat = float(shapes.getString(r, 'shape_pt_lat'));
    let lon = float(shapes.getString(r, 'shape_pt_lon'));
    let seq = int(shapes.getString(r, 'shape_pt_sequence'));

    if (!shapesById[shape_id]) shapesById[shape_id] = [];
    
    let mapped = mapCoordinates(lon, lat);
    shapesById[shape_id].push({
      x: mapped.x, 
      y: mapped.y, 
      seq: seq
    });
  }

  // Sort all shapes by sequence
  for (let shape_id in shapesById) {
    shapesById[shape_id].sort((a, b) => a.seq - b.seq);
  }
  
  return shapesById;
}
function drawStops() {
  if (!stops) return;

  let seen = new Set();
  stroke(0);
  strokeWeight(0.5);
  rectMode(CENTER);

  for (let r = 0; r < stops.getRowCount(); r++) {
    let stop_id = stops.getString(r, 'stop_id');
    let stop_name = stops.getString(r, 'stop_name');
    let lat = float(stops.getString(r, 'stop_lat'));
    let lon = float(stops.getString(r, 'stop_lon'));
    
    // Skip invalid coordinates or duplicate stop names
    if (isNaN(lat) || isNaN(lon) || seen.has(stop_name)) continue;
    seen.add(stop_name);

    let lineLetter = getStopLineLetter(stop_id, r);
    if (!lineLetter || !subteColors[lineLetter]) continue;

    fill(subteColors[lineLetter]);
    let mapped = mapCoordinates(lon, lat);
    rect(mapped.x, mapped.y, 6, 6);
  }
}

function getStopLineLetter(stop_id, stopRowIndex) {
  if (city === "BA" || city === "NYC" || city === "BE") {
    let route_id = stopToRouteCache[stop_id];
    if (route_id) {
      let route_short_name = routeToLineCache[route_id];
      return route_short_name ? route_short_name.charAt(0) : null;
    }
  } else if (city === "CDMX" || city === "SDC") {
    return stops.getString(stopRowIndex, 'line_id');
  }
  return null;
}


// ========== VAGONS ==========
function prepareShapePaths() {
  if (!shapes) return;
  
  shapePaths = {};
  
  for (let r = 0; r < shapes.getRowCount(); r++) {
    let shape_id = shapes.getString(r, 'shape_id');
    let lat = float(shapes.getString(r, 'shape_pt_lat'));
    let lon = float(shapes.getString(r, 'shape_pt_lon'));
    let seq = int(shapes.getString(r, 'shape_pt_sequence'));

    if (!shapePaths[shape_id]) shapePaths[shape_id] = [];
    
    let mapped = mapCoordinates(lon, lat);
    shapePaths[shape_id].push({
      x: mapped.x, 
      y: mapped.y, 
      seq: seq
    });
  }

  // Sort all paths by sequence
  for (let sid in shapePaths) {
    shapePaths[sid].sort((a, b) => a.seq - b.seq);
  }
  
  console.log(`Prepared ${Object.keys(shapePaths).length} shape paths`);
}

function setupVagons() {
  vagons = []; // Clear existing vagons
  
  const TRAINS_PER_LINE = 2;
  const BASE_SPEED = 0.001;
  const SPEED_VARIATION = 0.002;
  
  for (let shape_id in shapePaths) {
    let lineLetter = getLineLetterFromShape(shape_id, city);
    let lineColor = subteColors[lineLetter];
    
    // Skip shapes without valid colors
    if (!lineColor) {
      console.warn(`No color found for line: ${lineLetter} (shape: ${shape_id})`);
      lineColor = color(random(50, 255), random(50, 255), random(50, 255));
    }
    
    for (let i = 0; i < TRAINS_PER_LINE; i++) {
      vagons.push({
        shape_id: shape_id,
        pos: random(), // Random starting position
        speed: BASE_SPEED + random(0, SPEED_VARIATION),
        color: lineColor
      });
    }
  }
  
  console.log(`Created ${vagons.length} vagons for ${Object.keys(shapePaths).length} shapes`);
}

function drawVagons() {
  strokeWeight(1);
  for (let v of vagons) {
    let path = shapePaths[v.shape_id];
    if (!path || path.length < 5) continue;

    let total = path.length - 1;
    let idxF = v.pos * total;
    let idx = floor(idxF);
    let t = idxF - idx;

    let p1 = path[idx];
    let p2 = path[min(idx+1, total)];

    let x = lerp(p1.x, p2.x, t);
    let y = lerp(p1.y, p2.y, t);

    fill(v.color);
    stroke(0);
    ellipse(x, y, 8, 8);

    v.pos += v.speed;
    if (v.pos > 1) v.pos = 0;
  }
}

// ========== INTERACTIVITY ==========
function mouseWheel(event) {
  const ZOOM_FACTOR = 0.1;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 5.0;
  
  let zoomChange = event.delta > 0 ? -ZOOM_FACTOR : ZOOM_FACTOR;
  zoom = constrain(zoom + zoomChange, MIN_ZOOM, MAX_ZOOM);
  
  return false; // Prevent page scrolling
}

function mousePressed() {
  dragging = true;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseReleased() {
  dragging = false;
}

function mouseDragged() {
  if (dragging) {
    offsetX += (mouseX - lastX);
    offsetY += (mouseY - lastY);
    lastX = mouseX;
    lastY = mouseY;
  }
}

// ========== CITY SWITCHING ==========
function switchCity(newCity) {
  if (!SUPPORTED_CITIES.includes(newCity)) {
    console.error(`Unsupported city: ${newCity}`);
    return false;
  }
  
  if (newCity === city) return true; // Already loaded
  
  console.log(`Switching from ${city} to ${newCity}`);
  city = newCity;
  
  // Reset caches and processed data
  resetDataCaches();
  
  // Reload data for new city
  preload();
  
  return true;
}

function resetDataCaches() {
  processedShapes = null;
  routeToLineCache = {};
  tripToRouteCache = {};
  stopToRouteCache = {};
  shapePaths = {};
  vagons = [];
  comunaColors = [];
}

// ========== KEYBOARD CONTROLS ==========
function keyPressed() {
  switch(key.toLowerCase()) {
    case '1': switchCity('BA'); break;
    case '2': switchCity('NYC'); break;
    case '3': switchCity('CDMX'); break;
    case '4': switchCity('BE'); break;
    case '5': switchCity('SDC'); break;
    case 'r': 
      // Reset zoom and pan
      zoom = 1;
      offsetX = 0;
      offsetY = 0;
      break;
  }
}
