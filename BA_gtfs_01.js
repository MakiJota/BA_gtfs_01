
let comunas, stops, routes, shapes, trips, stopTimes;
let lonMin, lonMax, latMin, latMax;
let subteColors; 
let titleText;

let buttonBA, buttonNYC, buttonCDMX,  buttonBE;

// ================== CONFIG ==================
//let city = "NYC"; // <-- change to "NYC" to switch
//let city = "BA"; // <-- change to "BA" to switch
//let city = "CDMX"; // <-- change to "CDMX" to switch
//let city = "BE"; // <-- change to BE" to switch

let city = "SDC";


// Active config
//let cfg = cityConfigs[city];
let cfg ;
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

function preload() {
  console.log(`Loading assets/${city}/config.json`);

  // ✅ Use callback to access loaded JSON
  cfg = loadJSON(`assets/${city}/config.json`, (data) => {
    console.log("Config loaded:", data);
    cfg = data; // assign the fully loaded data

    // Now you can safely load dependent files
    city_limit = loadJSON(cfg.folder + 'limit.geojson');
    stops      = loadTable(cfg.folder + 'GTFS/stops.txt', 'csv', 'header');
    routes     = loadTable(cfg.folder + 'GTFS/routes.txt', 'csv', 'header');
    shapes     = loadTable(cfg.folder + 'GTFS/shapes.txt', 'csv', 'header');
    trips      = loadTable(cfg.folder + 'GTFS/trips.txt', 'csv', 'header');
    stopTimes  = loadTable(cfg.folder + 'GTFS/stop_times.txt', 'csv', 'header');
  });
}


function setup() {
  createCanvas(1200, 1200);
  console.log("Setup complete for " + city);

  lonMin = cfg.lonMin;
  lonMax = cfg.lonMax;
  latMin = cfg.latMin;
  latMax = cfg.latMax;
  subteColors = cfg.colors;
  titleText = cfg.title;

  if (city_limit) {
    for (let i = 0; 
    i < city_limit.features.length; 
    i++) {
      comunaColors[i] = color(random(180, 230), 200);
    }
  }

  prepareShapePaths();
  setupVagons();
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

      let x = map(lon, lonMin, lonMax, 50, width - 50);
      let y = map(lat, latMin, latMax, height - 50, 50);

      vertex(x, y);
    }
    endShape(CLOSE);
  }
}

function drawSubteRoutes() {
  if (!shapes) return;

  strokeWeight(3);

  // group shapes by ID
  let shapesById = {};
  for (let r = 0; r < shapes.getRowCount(); r++) {
    let shape_id = shapes.getString(r, 'shape_id');
    let lat = float(shapes.getString(r, 'shape_pt_lat'));
    let lon = float(shapes.getString(r, 'shape_pt_lon'));
    let seq = int(shapes.getString(r, 'shape_pt_sequence'));

    if (!shapesById[shape_id]) shapesById[shape_id] = [];
    shapesById[shape_id].push({lat, lon, seq});
  }

  // draw each shape
  for (let shape_id in shapesById) {
    console.log("Drawing shape:", shape_id);
    let pts = shapesById[shape_id];
    pts.sort((a,b) => a.seq - b.seq);

    
    if (city === "BA" || city === "NYC" || city === "BE") {
      // For these cities, the first character or line code works
      lineLetter = shape_id.charAt(0);
    } else if (city === "CDMX"|| city === "SDC") {
      // For CDMX, the full shape_id is used as the key
      lineLetter = shape_id;
    }

    // Use lineLetter to get the color
    stroke(subteColors[lineLetter] || 'black');
    
    console.log("actual label", lineLetter);
    
    noFill();

    beginShape();
    for (let pt of pts) {
      let x = map(pt.lon, lonMin, lonMax, 50, width - 50);
      let y = map(pt.lat, latMin, latMax, height - 50, 50);
      vertex(x, y);
    }
    endShape();
  }
}
function drawStops() {
  if (!stops || !routes || !trips || !stopTimes) return;

  // Map route_id → route_short_name
  let routeToLine = {};
  for (let r = 0; r < routes.getRowCount(); r++) {
    let route_id = routes.getString(r, 'route_id');
    let route_short_name = routes.getString(r, 'route_short_name'); 
    routeToLine[route_id] = route_short_name;
  }

  // Map trip_id → route_id
  let tripToRoute = {};
  for (let r = 0; r < trips.getRowCount(); r++) {
    tripToRoute[trips.getString(r, 'trip_id')] = trips.getString(r, 'route_id');
  }

  // Map stop_id → route_id (via stop_times)
  let stopToRoute = {};
  for (let r = 0; r < stopTimes.getRowCount(); r++) {
    let stop_id = stopTimes.getString(r, 'stop_id');
    let trip_id = stopTimes.getString(r, 'trip_id');
    let route_id = tripToRoute[trip_id];
    if (route_id && !stopToRoute[stop_id]) {
      stopToRoute[stop_id] = route_id;
    }
  }

  let seen = new Set();

  stroke(0);
  strokeWeight(1);

  for (let r = 0; r < stops.getRowCount(); r++) {
    let stop_id = stops.getString(r, 'stop_id');
    let stop_name = stops.getString(r, 'stop_name');
    let lat = float(stops.getString(r, 'stop_lat'));
    let lon = float(stops.getString(r, 'stop_lon'));
    if (isNaN(lat) || isNaN(lon)) continue;

    if (seen.has(stop_name)) continue;
    seen.add(stop_name);

    let route_id = stopToRoute[stop_id];
    let lineLetter = null;

    if (city === "BA" || city === "NYC" || city === "BE") {
      
      if (route_id) lineLetter = routeToLine[route_id].charAt(0);
      
    } else if (city === "CDMX" || city === "SDC" ) {
      
      lineLetter = stops.getString(r, 'line_id');
    }

    if (!lineLetter || !subteColors[lineLetter]) continue;

    fill(subteColors[lineLetter]);
    let x = map(lon, lonMin, lonMax, 50, width - 50);
    let y = map(lat, latMin, latMax, height - 50, 50);

    stroke(0);
    strokeWeight(0.5);
    rectMode(CENTER);
    rect(x, y, 6, 6);
  }
}


// ========== VAGONS ==========
function prepareShapePaths() {
  if (!shapes) return;
  for (let r = 0; r < shapes.getRowCount(); r++) {
    let shape_id = shapes.getString(r, 'shape_id');
    let lat = float(shapes.getString(r, 'shape_pt_lat'));
    let lon = float(shapes.getString(r, 'shape_pt_lon'));
    let seq = int(shapes.getString(r, 'shape_pt_sequence'));

    if (!shapePaths[shape_id]) shapePaths[shape_id] = [];
    let x = map(lon, lonMin, lonMax, 50, width - 50);
    let y = map(lat, latMin, latMax, height - 50, 50);
    shapePaths[shape_id].push({x, y, seq});
  }

  for (let sid in shapePaths) {
    shapePaths[sid].sort((a,b) => a.seq - b.seq);
  }
}

function setupVagons() {
  for (let shape_id in shapePaths) {
    for (let i = 0; i < 2; i++) { // 3 trains per line
      let lineLetter = shape_id.charAt(0);
      
          if (city === "BA" || city === "NYC" || city === "BE") {
      // For these cities, the first character or line code works
      lineLetter = shape_id.charAt(0);
    } else if (city === "CDMX"|| city === "SDC") {
      // For CDMX, the full shape_id is used as the key
      lineLetter = shape_id;
    }
      
      
      
      let col = subteColors[lineLetter] || color(random(50, 255), random(50, 255), random(50, 255));
      vagons.push({
        shape_id: shape_id,
        pos: random(),
        speed: 0.001 + random(0,0.002),
        color: col
      });
    }
  }
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
  zoom *= (event.delta > 0) ? 0.9 : 1.1;
  return false;
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
  
