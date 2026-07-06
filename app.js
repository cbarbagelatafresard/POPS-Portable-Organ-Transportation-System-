// ═══════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════
const ESP32_IP         = "172.20.83.242";
const ESP32_WS_URL     = "ws://" + ESP32_IP + ":81";
const TEMP_MIN         = 2;
const TEMP_MAX         = 8;
const TEMP_SETPOINT    = 4;
const TEMP_READY       = 4;
const RECONNECT_MS     = 3000;

// ═══════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════
let sessionData      = {};
let sessionTimer     = null;
let sessionSeconds   = 0;
let isConnected      = false;
let lastKnownData    = null;
let tempChart        = null;
let displayHistory   = { labels: [], values: [] };
let rawData          = [];
let ws               = null;
let wsReconnectTimer = null;
let finalizandoDesdeESP32 = false;
let stats = {
  tempMax: -Infinity, tempMin: Infinity,
  tempSum: 0, tempCount: 0,
  aperturas: 0,
  horaInicio: null, horaFin: null
};

let alarmas = {
  temp: false, tapa: false, bateria: false
};

let toastTimer   = null;
let popupQueue   = [];
let popupVisible = false;
let guardarDatos = false;

// ═══════════════════════════════════════
// HELPERS DE FORMATO
// ═══════════════════════════════════════
function formatearTexto(texto) {
  return texto.charAt(0).toUpperCase() + texto.slice(1).toLowerCase();
}

function formatearNombre(texto) {
  return texto
    .split(" ")
    .filter(p => p.length > 0)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

// ═══════════════════════════════════════
// VALIDACIONES EN TIEMPO REAL
// ═══════════════════════════════════════
document.getElementById("matricula").addEventListener("input", function() {
  this.value = this.value.replace(/[^0-9]/g, "");
});
document.getElementById("medico").addEventListener("input", function() {
  this.value = this.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]/g, "");
});
document.getElementById("origen").addEventListener("input", function() {
  this.value = this.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]/g, "");
});
document.getElementById("destino").addEventListener("input", function() {
  this.value = this.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]/g, "");
});

// ═══════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════
function conectarWS() {
  if (ws) ws.close();

  ws = new WebSocket(ESP32_WS_URL);

  ws.onopen = function() {
    isConnected = true;
    finalizandoDesdeESP32 = false;
    setConexion(true);
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    agregarLog("Conexión establecida con el dispositivo", "ok");
  };

  ws.onmessage = function(event) {
    try {
      const data = JSON.parse(event.data);

      if (data.evento === "finalizar") {
        const dash = document.getElementById("screen-dash");
        if (dash.classList.contains("active")) {
          pararTimers();
          stats.horaFin = new Date();
          mostrarPantalla("screen-finalizar");
        }
        return;
      }

      lastKnownData = data;

      const cooling = document.getElementById("screen-cooling");
      const dash    = document.getElementById("screen-dash");

      if (cooling.classList.contains("active")) {
        actualizarPantallaCooling(data);
      } else if (dash.classList.contains("active")) {
        actualizarDashboard(data);
      }
    } catch(e) {
      console.error("Error parseando JSON:", e);
    }
  };

  ws.onerror = function() {
    isConnected = false;
    setConexion(false);
  };

  ws.onclose = function() {
    isConnected = false;
    setConexion(false);
    wsReconnectTimer = setTimeout(conectarWS, RECONNECT_MS);
  };
}

// ═══════════════════════════════════════
// PANTALLA 1 — PREENFRIAMIENTO
// ═══════════════════════════════════════
function iniciarApp() {
  mostrarPantalla("screen-cooling");
  conectarWS();
}

function actualizarPantallaCooling(data) {
  const temp = parseFloat(data.temp);
  guardarRaw(data);

  document.getElementById("cooling-temp").textContent    = temp.toFixed(1);
  document.getElementById("cooling-bateria").textContent = "—";

  const pct = Math.max(0, Math.min(100, ((25 - temp) / 25) * 100));
  document.getElementById("cooling-bar").style.width = pct + "%";

  if (temp <= TEMP_READY && isConnected) {
    mostrarListaParaUsar(temp);
  }
}

function mostrarListaParaUsar(temp) {
  mostrarPantalla("screen-ready");
  document.getElementById("ready-temp").textContent    = parseFloat(temp).toFixed(1);
  document.getElementById("ready-bateria").textContent = "—";
}

// ═══════════════════════════════════════
// PANTALLA 2 → 3 — COMENZAR REGISTRO
// ═══════════════════════════════════════
function comenzarRegistro() {
  stats.horaInicio = new Date();
  mostrarDashboard();
}

// ═══════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════
function mostrarDashboard() {
  mostrarPantalla("screen-dash");

  document.getElementById("dash-organo-badge").classList.add("hidden");
  document.getElementById("dash-meta-sep1").classList.add("hidden");
  document.getElementById("dash-meta-sep2").classList.add("hidden");
  document.getElementById("dash-medico").textContent     = "";
  document.getElementById("dash-ruta").textContent       = "";
  document.getElementById("dash-transporte").textContent = "";

  iniciarGrafico();

  sessionSeconds = 0;
  sessionTimer   = setInterval(actualizarTimer, 1000);

  agregarLog("Órgano insertado · inicio de registro", "normal");
}

// ═══════════════════════════════════════
// ACTUALIZAR DASHBOARD
// ═══════════════════════════════════════
function actualizarDashboard(data) {
  const temp = parseFloat(data.temp);

  guardarRaw(data);
  actualizarStats(temp, data);

  // Temperatura
  const tempEl    = document.getElementById("val-temp");
  const metricT   = tempEl.closest(".metric-card");
  const tempFuera = temp < TEMP_MIN || temp > TEMP_MAX;

  tempEl.textContent = temp.toFixed(1);
  tempEl.className   = "metric-value " + (tempFuera ? "val-alert" : "val-ok");

  if (tempFuera) {
    const msg = temp > TEMP_MAX
      ? "Temperatura demasiado alta: " + temp.toFixed(1) + "°C (máx. " + TEMP_MAX + "°C)"
      : "Temperatura demasiado baja: " + temp.toFixed(1) + "°C (mín. " + TEMP_MIN + "°C)";
    document.getElementById("banner-temp").classList.remove("hidden");
    document.getElementById("banner-temp-msg").textContent = msg;
    metricT.classList.add("alarma");
    if (!alarmas.temp) {
      alarmas.temp = true;
      agregarLog("⚠ " + msg, "alert");
      mostrarPopup("Alerta de temperatura", msg);
    }
  } else {
    document.getElementById("banner-temp").classList.add("hidden");
    metricT.classList.remove("alarma");
    if (alarmas.temp) {
      alarmas.temp = false;
      agregarLog("✓ Temperatura normalizada: " + temp.toFixed(1) + "°C", "ok");
      mostrarToast("Temperatura normalizada — " + temp.toFixed(1) + "°C");
    }
  }

  document.getElementById("val-setpoint").textContent = data.setpoint ?? TEMP_SETPOINT;

  // Batería — guión
  const batEl   = document.getElementById("val-bateria");
  const metricB = batEl.closest(".metric-card");
  batEl.textContent = "—";
  batEl.className   = "metric-value";
  document.getElementById("sub-bateria").textContent = "—";
  metricB.classList.remove("alarma");
  document.getElementById("banner-bateria").classList.add("hidden");

  // Alimentación
  const alimEl = document.getElementById("val-alimentacion");
  alimEl.textContent =
    data.alimentacion === "red"     ? "Red" :
    data.alimentacion === "bateria" ? "Batería" : "—";
  alimEl.className = "metric-value metric-small " +
    (data.alimentacion === "red"     ? "val-ok"  :
     data.alimentacion === "bateria" ? "val-warn" : "");
  document.getElementById("sub-alimentacion").textContent =
    data.alimentacion === "red"     ? "UPS activo" :
    data.alimentacion === "bateria" ? "Sin alimentación externa" : "—";

  // Tapa
  const tapaEl     = document.getElementById("val-tapa");
  const metricTapa = tapaEl.closest(".metric-card");
  const tapaAbierta = data.tapa === "abierta";

  tapaEl.textContent = tapaAbierta ? "Abierta" : "Cerrada";
  tapaEl.className   = "metric-value metric-small " + (tapaAbierta ? "val-alert" : "val-ok");
  document.getElementById("sub-tapa").textContent =
    tapaAbierta ? "Apertura detectada" : "Sellada correctamente";

  if (tapaAbierta) {
    metricTapa.classList.add("alarma");
    document.getElementById("banner-tapa").classList.remove("hidden");
    if (!alarmas.tapa) {
      alarmas.tapa = true;
      stats.aperturas++;
      agregarLog("⚠ Tapa abierta — verificar cierre", "alert");
      mostrarPopup("Tapa abierta", "Se detectó la apertura de la tapa del dispositivo. Verificar el cierre correcto para mantener la temperatura.");
    }
  } else {
    metricTapa.classList.remove("alarma");
    document.getElementById("banner-tapa").classList.add("hidden");
    if (alarmas.tapa) {
      alarmas.tapa = false;
      const popupTitle = document.getElementById("popup-title");
      if (popupTitle.textContent === "Tapa abierta") {
        cerrarPopup();
      }
      agregarLog("✓ Tapa cerrada correctamente", "ok");
      mostrarToast("Tapa cerrada correctamente");
    }
  }

  actualizarGrafico(temp, data.setpoint ?? TEMP_SETPOINT);
}

// ═══════════════════════════════════════
// SISTEMA DE ALARMAS
// ═══════════════════════════════════════
function mostrarPopup(titulo, mensaje) {
  popupQueue.push({ titulo, mensaje });
  if (!popupVisible) procesarPopupQueue();
}

function procesarPopupQueue() {
  if (popupQueue.length === 0) { popupVisible = false; return; }
  popupVisible = true;
  const { titulo, mensaje } = popupQueue.shift();
  document.getElementById("popup-title").textContent = titulo;
  document.getElementById("popup-msg").textContent   = mensaje;
  document.getElementById("popup-alarma").classList.remove("hidden");
}

function cerrarPopup() {
  document.getElementById("popup-alarma").classList.add("hidden");
  popupVisible = false;
  setTimeout(procesarPopupQueue, 200);
}

function mostrarToast(mensaje) {
  if (toastTimer) clearTimeout(toastTimer);
  const toast = document.getElementById("toast-ok");
  document.getElementById("toast-ok-msg").textContent = mensaje;
  toast.classList.remove("hidden");
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3500);
}

// ═══════════════════════════════════════
// STATS + RAW DATA
// ═══════════════════════════════════════
function actualizarStats(temp, data) {
  if (temp > stats.tempMax) stats.tempMax = temp;
  if (temp < stats.tempMin) stats.tempMin = temp;
  stats.tempSum += temp;
  stats.tempCount++;
}

function guardarRaw(data) {
  rawData.push({
    timestamp:    new Date().toISOString(),
    temp:         parseFloat(data.temp).toFixed(2),
    setpoint:     data.setpoint ?? TEMP_SETPOINT,
    alimentacion: data.alimentacion ?? "—",
    tapa:         data.tapa
  });
}

// ═══════════════════════════════════════
// PANTALLA 4 — OPCIONES DE FINALIZACIÓN
// ═══════════════════════════════════════
function mostrarOpcionesFinalizar() {
  mostrarPantalla("screen-finalizar");
}

function cancelarFinalizar() {
  mostrarPantalla("screen-dash");
}

function finalizarSinGuardado() {
  guardarDatos = false;
  pararTimers();
  stats.horaFin = new Date();
  document.getElementById("end-sub").textContent = "La sesión finalizó sin guardar los datos.";
  document.getElementById("end-summary").classList.add("hidden");
  document.getElementById("end-summary").innerHTML = "";
  mostrarPantalla("screen-end");
}

function finalizarConGuardado() {
  guardarDatos = true;
  pararTimers();
  stats.horaFin = new Date();
  mostrarPantalla("screen-form");
}

function pararTimers() {
  clearInterval(sessionTimer);
}

// ═══════════════════════════════════════
// FORMULARIO
// ═══════════════════════════════════════
document.getElementById("transplant-form").addEventListener("submit", function(e) {
  e.preventDefault();

  const titulo     = document.getElementById("titulo").value.trim();
  const medico     = document.getElementById("medico").value.trim();
  const matricula  = document.getElementById("matricula").value.trim();
  const organo     = document.getElementById("organo").value;
  const origen     = document.getElementById("origen").value.trim();
  const destino    = document.getElementById("destino").value.trim();
  const hora       = document.getElementById("hora-extraccion").value;
  const tiempo     = document.getElementById("tiempo-estimado").value;
  const transporte = document.getElementById("transporte").value;
  const errorEl    = document.getElementById("form-error");

  if (!titulo || !medico || !matricula || !organo || !origen || !destino || !hora || !tiempo || !transporte) {
    errorEl.textContent = "Completá todos los campos antes de continuar.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!/^\d+$/.test(matricula)) {
    errorEl.textContent = "La matrícula debe contener solo números.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]+$/.test(medico)) {
    errorEl.textContent = "El nombre del médico debe contener solo letras.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]+$/.test(origen)) {
    errorEl.textContent = "El lugar de origen debe contener solo letras.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!/^[a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s]+$/.test(destino)) {
    errorEl.textContent = "El lugar de destino debe contener solo letras.";
    errorEl.classList.remove("hidden");
    return;
  }

  errorEl.classList.add("hidden");

  sessionData = {
    medico:    titulo + " " + formatearNombre(medico),
    matricula, organo,
    origen:    formatearTexto(origen),
    destino:   formatearTexto(destino),
    hora, tiempo, transporte
  };

  descargarCSV();
  descargarReporte();
  mostrarResumenFinal();
});

// ═══════════════════════════════════════
// RESUMEN FINAL
// ═══════════════════════════════════════
function mostrarResumenFinal() {
  const tempMedia = stats.tempCount > 0
    ? (stats.tempSum / stats.tempCount).toFixed(1) : "—";

  document.getElementById("end-sub").textContent = "El reporte fue descargado automáticamente.";
  document.getElementById("end-summary").classList.remove("hidden");
  document.getElementById("end-summary").innerHTML =
    "<strong>Médico:</strong> "            + sessionData.medico    + "<br>" +
    "<strong>Matrícula:</strong> "         + sessionData.matricula + "<br>" +
    "<strong>Órgano:</strong> "            + sessionData.organo    + "<br>" +
    "<strong>Ruta:</strong> "              + sessionData.origen + " → " + sessionData.destino + "<br>" +
    "<strong>Transporte:</strong> "        + sessionData.transporte + "<br>" +
    "<strong>Inicio:</strong> "            + formatFecha(stats.horaInicio) + "<br>" +
    "<strong>Fin:</strong> "               + formatFecha(stats.horaFin)    + "<br>" +
    "<strong>Duración:</strong> "          + formatDuracion(sessionSeconds) + "<br>" +
    "<strong>Temp. máxima:</strong> "      + (stats.tempMax === -Infinity ? "—" : stats.tempMax.toFixed(1)) + "°C<br>" +
    "<strong>Temp. mínima:</strong> "      + (stats.tempMin ===  Infinity ? "—" : stats.tempMin.toFixed(1)) + "°C<br>" +
    "<strong>Temp. media:</strong> "       + tempMedia + "°C<br>" +
    "<strong>Aperturas de tapa:</strong> " + stats.aperturas;

  mostrarPantalla("screen-end");
}

// ═══════════════════════════════════════
// DESCARGA CSV
// ═══════════════════════════════════════
function descargarCSV() {
  const header = "timestamp,temp_C,setpoint_C,alimentacion,tapa\n";
  const rows   = rawData.map(r =>
    r.timestamp + "," + r.temp + "," + r.setpoint + "," +
    r.alimentacion + "," + r.tapa
  ).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
  descargarBlob(blob, "POPS_datos_" + formatNombreArchivo(stats.horaInicio) + ".csv");
}

// ═══════════════════════════════════════
// DESCARGA REPORTE TXT
// ═══════════════════════════════════════
function descargarReporte() {
  const tempMedia = stats.tempCount > 0
    ? (stats.tempSum / stats.tempCount).toFixed(1) : "—";

  const lines = [
    "═══════════════════════════════════════════",
    "  POPS — Reporte de sesión",
    "  Portable Organ Preservation System",
    "═══════════════════════════════════════════",
    "",
    "DATOS DEL MÉDICO",
    "───────────────────────────────────────────",
    "Médico responsable  : " + sessionData.medico,
    "N° de matrícula     : " + sessionData.matricula,
    "",
    "DATOS DEL TRASPLANTE",
    "───────────────────────────────────────────",
    "Órgano              : " + sessionData.organo,
    "Lugar de origen     : " + sessionData.origen,
    "Lugar de destino    : " + sessionData.destino,
    "Método de transporte: " + sessionData.transporte,
    "Hora de extracción  : " + sessionData.hora,
    "",
    "REGISTRO DE SESIÓN",
    "───────────────────────────────────────────",
    "Inicio de sesión    : " + formatFecha(stats.horaInicio),
    "Fin de sesión       : " + formatFecha(stats.horaFin),
    "Duración total      : " + formatDuracion(sessionSeconds),
    "",
    "DATOS DE TEMPERATURA",
    "───────────────────────────────────────────",
    "Temperatura máxima  : " + (stats.tempMax === -Infinity ? "—" : stats.tempMax.toFixed(1)) + " °C",
    "Temperatura mínima  : " + (stats.tempMin ===  Infinity ? "—" : stats.tempMin.toFixed(1)) + " °C",
    "Temperatura media   : " + tempMedia + " °C",
    "Rango seguro        : " + TEMP_MIN + " – " + TEMP_MAX + " °C",
    "",
    "EVENTOS",
    "───────────────────────────────────────────",
    "Aperturas de tapa   : " + stats.aperturas,
    "",
    "═══════════════════════════════════════════",
    "  Generado por POPS · Grupo 3 · ITBA 2026",
    "═══════════════════════════════════════════"
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8;" });
  descargarBlob(blob, "POPS_reporte_" + formatNombreArchivo(stats.horaInicio) + ".txt");
}

function descargarBlob(blob, nombre) {
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href      = url;
  link.download  = nombre;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════
// VOLVER A PREENFRIAMIENTO
// ═══════════════════════════════════════
function volverAPreenfriamiento() {
  document.getElementById("transplant-form").reset();
  displayHistory = { labels: [], values: [] };
  rawData        = [];
  alarmas        = { temp: false, tapa: false, bateria: false };
  finalizandoDesdeESP32 = false;
  stats = {
    tempMax: -Infinity, tempMin: Infinity,
    tempSum: 0, tempCount: 0,
    aperturas: 0,
    horaInicio: null, horaFin: null
  };
  sessionData    = {};
  sessionSeconds = 0;

  document.getElementById("event-log").innerHTML =
    '<div class="log-empty">Esperando eventos…</div>';
  if (tempChart) { tempChart.destroy(); tempChart = null; }

  document.getElementById("cooling-temp").textContent    = "—";
  document.getElementById("cooling-bateria").textContent = "—";
  document.getElementById("cooling-bar").style.width     = "0%";

  iniciarApp();
}

// ═══════════════════════════════════════
// TIMER
// ═══════════════════════════════════════
function actualizarTimer() {
  sessionSeconds++;
  document.getElementById("dash-timer").textContent =
    pad(Math.floor(sessionSeconds / 60)) + ":" + pad(sessionSeconds % 60);
}

// ═══════════════════════════════════════
// CONEXIÓN
// ═══════════════════════════════════════
function setConexion(ok) {
  const badge  = document.getElementById("connection-status");
  const label  = badge.querySelector(".conn-label");
  const banner = document.getElementById("alert-disconnected");
  badge.className   = "conn-badge " + (ok ? "conn-ok" : "conn-err");
  label.textContent = ok ? "Conectado" : "Sin conexión";
  banner.classList.toggle("hidden", ok);
}

// ═══════════════════════════════════════
// GRÁFICO
// ═══════════════════════════════════════
function iniciarGrafico() {
  const ctx = document.getElementById("temp-chart").getContext("2d");
  tempChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Temperatura",
          data: [],
          borderColor: "#1a2e44",
          backgroundColor: "rgba(26,46,68,0.07)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
          order: 1
        },
        {
          label: "Setpoint",
          data: [],
          borderColor: "#e8803a",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0,
          fill: false,
          order: 2
        },
        {
          label: "Límite máximo (8°C)",
          data: [],
          borderColor: "#c0392b",
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          tension: 0,
          fill: false,
          order: 3
        },
        {
          label: "Límite mínimo (2°C)",
          data: [],
          borderColor: "#c0392b",
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          tension: 0,
          fill: false,
          order: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { font: { family: "Space Mono", size: 9 }, color: "#6b7f96", maxTicksLimit: 8 },
          grid:  { color: "rgba(0,0,0,0.04)" }
        },
        y: {
          min: 0, max: 15,
          ticks: { font: { family: "Space Mono", size: 9 }, color: "#6b7f96" },
          grid:  { color: "rgba(0,0,0,0.04)" }
        }
      }
    }
  });
}

function actualizarGrafico(temp, setpoint) {
  if (!tempChart) return;

  const now   = new Date();
  const label = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());

  if (displayHistory.labels.length >= 60) {
    displayHistory.labels.shift();
    displayHistory.values.shift();
  }

  displayHistory.labels.push(label);
  displayHistory.values.push(parseFloat(temp));

  const n = displayHistory.labels.length;
  tempChart.data.labels           = displayHistory.labels;
  tempChart.data.datasets[0].data = displayHistory.values;
  tempChart.data.datasets[1].data = Array(n).fill(parseFloat(setpoint));
  tempChart.data.datasets[2].data = Array(n).fill(TEMP_MAX);
  tempChart.data.datasets[3].data = Array(n).fill(TEMP_MIN);
  tempChart.update();
}

// ═══════════════════════════════════════
// LOG DE EVENTOS
// ═══════════════════════════════════════
function agregarLog(texto, tipo) {
  const log   = document.getElementById("event-log");
  const empty = log.querySelector(".log-empty");
  if (empty) empty.remove();

  const now  = new Date();
  const hora = pad(now.getHours()) + ":" + pad(now.getMinutes());
  const item = document.createElement("div");
  item.className = "log-item";
  item.innerHTML =
    '<span class="log-time">' + hora + '</span>' +
    '<span class="log-text ' +
    (tipo === "warn"  ? "log-warn"  :
     tipo === "alert" ? "log-alert" :
     tipo === "ok"    ? "log-ok"    : "") +
    '">' + texto + '</span>';

  log.insertBefore(item, log.firstChild);

  const items = log.querySelectorAll(".log-item");
  if (items.length > 50) items[items.length - 1].remove();
}

// ═══════════════════════════════════════
// NAVEGACIÓN
// ═══════════════════════════════════════
function mostrarPantalla(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function pad(n)                 { return String(n).padStart(2, "0"); }
function formatDuracion(s)      { return pad(Math.floor(s/60)) + ":" + pad(s%60); }
function formatFecha(d)         { if (!d) return "—"; return d.toLocaleDateString("es-AR") + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function formatNombreArchivo(d) { if (!d) return "sesion"; return d.toISOString().slice(0,16).replace(/[T:]/g,"-"); }

// ═══════════════════════════════════════
// ARRANCAR
// ═══════════════════════════════════════
iniciarApp();