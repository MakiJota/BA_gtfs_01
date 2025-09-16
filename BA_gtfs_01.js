
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

let city = "CDMX";
const cityConfigs = {
  "BA": {
    folder: "assets/BA/",
    lonMin: -58.55, lonMax: -58.35,
    latMin: -34.7, latMax: -34.55,
    title: "Buenos Aires Subte Map",
    colors: {
      'A': '#00AEEF',   // light blue
      'B': '#DA291C',   // red
      'C': '#003DA5',   // blue
      'D': '#009739',   // green
      'E': '#702082',   // purple
      'H': '#FFD100'    // yellow
    }
  },
  "NYC": {
    folder: "assets/NYC/",
    lonMin: -74.05, lonMax: -73.75,
    latMin: 40.63,  latMax: 40.85,
    title: "New York City Subway Map",
    colors: {
      '1': '#EE352E', 
      '2': '#EE352E', 
      '3': '#EE352E',   // Red lines
      '4': '#00933C', 
      '5': '#00933C', 
      '6': '#00933C',   // Green lines
      '7': '#B933AD',                                  // Purple
      'A': '#2850AD', 
      'C': '#2850AD', 
      'E': '#2850AD',   // Blue
      'B': '#FF6319',
      'D': '#FF6319', 
      'F': '#FF6319', 
      'M': '#FF6319', // Orange
      'G': '#6CBE45',                                   // Light green
      'J': '#996633', 'Z': '#996633',                   // Brown
      'L': '#A7A9AC',                                   // Gray
      'N': '#FCCC0A', 
      'Q': '#FCCC0A', 
      'R': '#FCCC0A',
      'W': '#FCCC0A', // Yellow
      'S': '#808183'                                    // Shuttle (dark gray)
    }
  },
  "CDMX": {
    folder: "assets/CDMX/",
    lonMin: -99.35, lonMax: -98.90,  // bounding box for Mexico City
    latMin: 19.20,  latMax: 19.60,
    title: "Ciudad de México - Red de Transporte Público",
    colors: {
      // Metro
      '1':  '#f94f8e',
      '2':  '#0072c6',
      '3':  '#ad9b0c',
      '4':  '#7fbcaa',
      '5':  '#f9d616',
      '6':  '#d81e05',
      '7':  '#e87511',
      '8':  '#118749',
      '9':  '#512826',
      'A':  '#a02d96',
      'B':  '#118751',
      '12': '#b99e51',

      // Metrobús
      'MB1': '#d40d0d',
      'MB2': '#8d1a96',
      'MB3': '#13a810',
      'MB4': '#ff9a03',
      'MB5': '#141982',
      'MB6': '#e44599',
      'MB7': '#116633',

      // Trolebús (STE)
      'STE-CCE2': '#2dad18',
      'STE-CCE1': '#17a61d',
      'STE-CCE3': '#92d037',
      'STE-CP':   '#007eff',
      'STE-K1':   '#ff00fe',
      'STE-LL':   '#00fff6',
      'STE-TL1':  '#1f5af0',
      'STE-I':    '#7c30d4',
      'STE-G':    '#ffa800',

      // RTP (many use the same orange)
      'RTP': '#f27b0d',
      'RTP-Expreso': '#33c919',
      'RTP-Bicentenario': '#339c19',
      'ECOBUS': '#99ff48',

      // Suburban train
      'SUB1': '#ef1a1a'
    }
  },
    "BE": {
    folder: "assets/BE/",
    lonMin: 13.05, lonMax: 13.85,   // bounding box for Berlin
    latMin: 52.30, latMax: 52.65,
    title: "Berlin – S-Bahn Network",
    colors: {
      'S1':  '#a1232b', // dark red
      'S2':  '#00824b', // green
      'S25': '#5abf61', // light green
      'S26': '#63d196', // mint green
      'S3':  '#ea6815', // orange
      'S41': '#ba9f67', // brown-beige (ring clockwise)
      'S42': '#9f7c32', // brown (ring counter-clockwise)
      'S45': '#a2268a', // purple
      'S46': '#e73547', // pink-red
      'S47': '#f5b21e', // yellow
      'S5':  '#f5b21e', // same yellow as S47
      'S7':  '#5a62d4', // blue
      'S75': '#3670b2', // darker blue
      'S8':  '#c84c98', // magenta
      'S85': '#6f4e9e', // violet
      'S9':  '#009ac7'  // cyan
    }
  }
};

  

// Active config
let cfg = cityConfigs[city];

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
  city_limit   = loadJSON(cfg.folder + 'limit.geojson');
  stops     = loadTable(cfg.folder + 'GTFS/stops.txt', 'csv', 'header');
  routes    = loadTable(cfg.folder + 'GTFS/routes.txt', 'csv', 'header');
  shapes    = loadTable(cfg.folder + 'GTFS/shapes.txt', 'csv', 'header');
  trips     = loadTable(cfg.folder + 'GTFS/trips.txt', 'csv', 'header');
  stopTimes = loadTable(cfg.folder + 'GTFS/stop_times.txt', 'csv', 'header');
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
    let pts = shapesById[shape_id];
    pts.sort((a,b) => a.seq - b.seq);

    let lineLetter = shape_id.charAt(0); 
    stroke(subteColors[lineLetter] || 'black');
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

  let routeToLine = {};
  for (let r = 0; r < routes.getRowCount(); r++) {
    let route_id = routes.getString(r, 'route_id');
    let route_short_name = routes.getString(r, 'route_short_name'); 
    routeToLine[route_id] = route_short_name;
  }

  let tripToRoute = {};
  for (let r = 0; r < trips.getRowCount(); r++) {
    tripToRoute[trips.getString(r, 'trip_id')] = trips.getString(r, 'route_id');
  }

  let stopToRoute = {};
  for (let r = 0; r < stopTimes.getRowCount(); r++) {
    let stop_id = stopTimes.getString(r, 'stop_id');
    let trip_id = stopTimes.getString(r, 'trip_id');
    let route_id = tripToRoute[trip_id];
    if (route_id) {
      if (!stopToRoute[stop_id]) stopToRoute[stop_id] = route_id;
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
    let lineLetter = route_id ? routeToLine[route_id] : null;
    if (!lineLetter || !subteColors[lineLetter]) continue;

    fill(subteColors[lineLetter]);
    let x = map(lon, lonMin, lonMax, 50, width - 50);
    let y = map(lat, latMin, latMax, height - 50, 50);

    stroke(0);
    strokeWeight(0.5);
    ellipse(x, y, 6, 6);
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
    for (let i = 0; i < 3; i++) { // 3 trains per line
      let lineLetter = shape_id.charAt(0);
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
    if (!path || path.length < 2) continue;

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
  
