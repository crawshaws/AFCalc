/* Alchemy Factory Planner (Offline)
 * - Stores data in localStorage
 * - Import/Export JSON
 * - CRUD Materials, Machines (incl Furnace special case), Recipes
 */

(() => {
  "use strict";

  const STORAGE_KEY = "af_planner_db_v1";
  const BUILD_STORAGE_KEY = "af_planner_build_v1";
  const SKILLS_STORAGE_KEY = "af_planner_skills_v1";
  const UI_PREFS_STORAGE_KEY = "af_planner_ui_prefs_v1";
  const SCHEMA_VERSION = 1;
  
  // Game constants
  const CONVEYOR_SPEED = 60; // items per minute

  /** @type {AppState} */
  const state = {
    db: createEmptyDb(),
    ui: {
      activeTab: "materials",
      selected: {
        materials: null,
        machines: null,
      },
      filters: {
        materials: "",
        machines: "",
      },
      sidebars: {
        database: true,
        blueprints: false,
        production: false,
      },
      statusTimer: null,
      pendingStorageCoords: null,
      pendingManualStorageMachineId: null,
      pendingStorageReplacementId: null,
      pendingHeatingDeviceId: null,
      pendingBlueprintCoords: null,
      dragState: null, // For canvas dragging and connection preview
      justCompletedSelection: false, // Flag to prevent click from clearing selection after drag-select
      productionSummaryDebounceTimer: null, // Debounce timer for production summary recalculation
    },
    build: {
      placedMachines: [], // Array of placed machine instances on canvas
      connections: [], // Array of conveyor connections
      selectedMachines: [], // Array of selected machine IDs (supports multi-select)
      selectedConnection: null, // Currently selected connection on canvas
      camera: { x: 0, y: 0, zoom: 1.0 }, // Camera position (world coords at viewport center) and zoom level
    },
    blueprintEditStack: [], // Stack of canvas states when editing blueprints recursively
    currentBlueprintEdit: null, // { blueprintId, instanceId (if editing a placed instance), parentInstanceId (for nested edits) }
    blueprintMachineCountCache: {}, // Cache for recursive blueprint machine counts { blueprintId: { totalCount, breakdown: { machineId: count } } }
    skills: {
      conveyorSpeed: 0, // Each point = +15p/m speed bonus - Base 60p/m
      throwingSpeed: 0, // Each point = +15p/m speed bonus - Base 60p/m
      machineEfficiency: 0, // Each point = 25% reduction in processing time + 25% increase to fuel consumption - Base 100%
      alchemyEfficiency: 0, // Each point = +3% Extractor Output - Base 100% (Extractor is a machine that takes in solid produces liquid)
      fuelEfficiency: 0, // Each point = +10% fuel value of materials (Pyra/P) - Base 100%
      fertilizerEfficiency: 0, // Each point = +10% fertilizer Nutrient Value (V) - Base 100%      
      shopProfit: 0, // Each point = +3% (increasing) shop profit - Base 100%
    },
  };

  // ---------- DOM helpers ----------

  /** @param {string} sel */
  const $ = (sel) => document.querySelector(sel);
  /** @param {string} sel */
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function setStatus(text, kind = "info") {
    const el = $("#statusText");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    if (state.ui.statusTimer) window.clearTimeout(state.ui.statusTimer);
    state.ui.statusTimer = window.setTimeout(() => {
      el.textContent = "";
    }, 2500);
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function makeId(prefix) {
    // Good enough for local-only IDs.
    const rand = Math.random().toString(16).slice(2);
    return `${prefix}_${Date.now().toString(16)}_${rand}`;
  }

  function toNumberOrNull(v) {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function toIntOrNull(v) {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }

  // ---------- DB ----------

  function createEmptyDb() {
    const now = new Date().toISOString();
    return {
      version: SCHEMA_VERSION,
      meta: {
        createdAt: now,
        updatedAt: now,
      },
      materials: [],
      machines: [],
      recipes: [],
      blueprints: [],
    };
  }

  function touchUpdatedAt() {
    state.db.meta.updatedAt = new Date().toISOString();
  }

  function saveDb() {
    touchUpdatedAt();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.db, null, 2));
  }

  function loadDb() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyDb();
    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeDb(parsed);
      return normalized;
    } catch {
      return createEmptyDb();
    }
  }
  
  /**
   * Save the build to localStorage
   * IMPORTANT: Blueprint editing is an in-memory operation only.
   * When in blueprint edit mode, this saves the MAIN canvas (from the bottom of the edit stack),
   * NOT the current blueprint being edited. This ensures that refreshing the page always
   * loads the main canvas, and edits are only persisted when explicitly saved via
   * saveBlueprintEdit() or saveBlueprintAsNew().
   */
  function saveBuild() {
    let buildData;
    
    if (state.blueprintEditStack.length > 0) {
      // We're in blueprint edit mode - save the main canvas (bottom of stack)
      const mainCanvasState = state.blueprintEditStack[0];
      buildData = {
        placedMachines: mainCanvasState.placedMachines,
        connections: mainCanvasState.connections,
        camera: mainCanvasState.camera,
      };
    } else {
      // Normal mode - save current canvas
      buildData = {
        placedMachines: state.build.placedMachines,
        connections: state.build.connections,
        camera: state.build.camera,
      };
    }
    
    localStorage.setItem(BUILD_STORAGE_KEY, JSON.stringify(buildData, null, 2));
  }
  
  /**
   * Validate a build's connections against its placed machines
   * Returns list of validation issues
   */
  function validateBuild(placedMachines, connections) {
    const issues = [];
    const machineIds = new Set(placedMachines.map(pm => pm.id));
    
    connections.forEach((conn, idx) => {
      // Check if machines exist
      if (!machineIds.has(conn.fromMachineId)) {
        issues.push({
          type: 'missing-source',
          connection: idx,
          machineId: conn.fromMachineId,
          message: `Connection #${idx + 1}: Source machine no longer exists`
        });
        return;
      }
      
      if (!machineIds.has(conn.toMachineId)) {
        issues.push({
          type: 'missing-target',
          connection: idx,
          machineId: conn.toMachineId,
          message: `Connection #${idx + 1}: Target machine no longer exists`
        });
        return;
      }
      
      // Validate source port exists
      const sourceMachine = placedMachines.find(pm => pm.id === conn.fromMachineId);
      if (sourceMachine) {
        const sourceMachineDef = getMachineById(sourceMachine.machineId);
        if (sourceMachineDef) {
          // Check if it's a heating device with grouped ports
          if (sourceMachineDef.kind === "heating_device" && typeof conn.fromPortIdx === 'string') {
            if (conn.fromPortIdx.startsWith('grouped-output-')) {
              // Validate the material exists
              const materialId = conn.fromPortIdx.replace(/^grouped-output-/, '');
              if (!getMaterialById(materialId)) {
                issues.push({
                  type: 'invalid-port',
                  connection: idx,
                  message: `Connection #${idx + 1}: Output port references non-existent material`
                });
              }
            } else if (conn.fromPortIdx.startsWith('topper-')) {
              // Old topper port format - flag as outdated
              issues.push({
                type: 'outdated-port',
                connection: idx,
                message: `Connection #${idx + 1}: Uses outdated topper port format (should use grouped ports)`
              });
            }
          } else {
            // Regular port - check index is valid
            const portIdx = parseInt(conn.fromPortIdx);
            if (!isNaN(portIdx) && portIdx >= sourceMachineDef.outputs) {
              issues.push({
                type: 'invalid-port',
                connection: idx,
                message: `Connection #${idx + 1}: Output port ${portIdx} doesn't exist (machine has ${sourceMachineDef.outputs} outputs)`
              });
            }
          }
        }
      }
      
      // Validate target port exists
      const targetMachine = placedMachines.find(pm => pm.id === conn.toMachineId);
      if (targetMachine) {
        const targetMachineDef = getMachineById(targetMachine.machineId);
        if (targetMachineDef) {
          // Check if it's a heating device with grouped ports
          if (targetMachineDef.kind === "heating_device" && typeof conn.toPortIdx === 'string') {
            if (conn.toPortIdx === 'fuel') {
              // Valid fuel port
            } else if (conn.toPortIdx.startsWith('grouped-input-')) {
              // Validate the material exists
              const materialId = conn.toPortIdx.replace(/^grouped-input-/, '');
              if (!getMaterialById(materialId)) {
                issues.push({
                  type: 'invalid-port',
                  connection: idx,
                  message: `Connection #${idx + 1}: Input port references non-existent material`
                });
              }
            } else if (conn.toPortIdx.startsWith('topper-')) {
              // Old topper port format - flag as outdated
              issues.push({
                type: 'outdated-port',
                connection: idx,
                message: `Connection #${idx + 1}: Uses outdated topper port format (should use grouped ports)`
              });
            }
          } else {
            // Regular port - check index is valid
            const portIdx = parseInt(conn.toPortIdx);
            if (!isNaN(portIdx) && portIdx >= targetMachineDef.inputs) {
              issues.push({
                type: 'invalid-port',
                connection: idx,
                message: `Connection #${idx + 1}: Input port ${portIdx} doesn't exist (machine has ${targetMachineDef.inputs} inputs)`
              });
            }
          }
        }
      }
    });
    
    return issues;
  }
  
  /**
   * Show validation warning to user
   */
  function showValidationWarning(issues, source = 'file') {
    if (issues.length === 0) return;
    
    const warningDiv = document.createElement('div');
    warningDiv.className = 'validation-warning';
    warningDiv.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      background: rgba(255, 107, 107, 0.95);
      color: white;
      padding: 16px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      max-width: 400px;
      z-index: 10000;
      font-size: 13px;
      line-height: 1.5;
    `;
    
    const title = document.createElement('div');
    title.style.cssText = 'font-weight: 700; font-size: 14px; margin-bottom: 8px;';
    title.textContent = `⚠️ Invalid Connections Detected (${issues.length})`;
    
    const message = document.createElement('div');
    message.style.cssText = 'margin-bottom: 12px;';
    message.textContent = `Your ${source} contains ${issues.length} invalid connection${issues.length > 1 ? 's' : ''} that may cause incorrect calculations.`;
    
    const detailsBtn = document.createElement('button');
    detailsBtn.textContent = 'Show Details';
    detailsBtn.className = 'btn btn--sm';
    detailsBtn.style.cssText = 'margin-right: 8px;';
    detailsBtn.onclick = () => {
      console.group('🔍 Build Validation Issues');
      issues.forEach(issue => {
        console.warn(issue.message, issue);
      });
      console.groupEnd();
      alert(`Validation Issues:\n\n${issues.map(i => `• ${i.message}`).join('\n')}\n\nCheck the console for details.`);
    };
    
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'btn btn--sm';
    dismissBtn.onclick = () => warningDiv.remove();
    
    warningDiv.appendChild(title);
    warningDiv.appendChild(message);
    warningDiv.appendChild(detailsBtn);
    warningDiv.appendChild(dismissBtn);
    document.body.appendChild(warningDiv);
    
    // Auto-dismiss after 15 seconds
    setTimeout(() => {
      if (warningDiv.parentNode) {
        warningDiv.remove();
      }
    }, 15000);
  }
  
  function loadBuild() {
    const raw = localStorage.getItem(BUILD_STORAGE_KEY);
    if (!raw) return { placedMachines: [], connections: [] };
    try {
      const parsed = JSON.parse(raw);
      const placedMachines = Array.isArray(parsed.placedMachines) 
        ? parsed.placedMachines.map(pm => {
            const normalized = {
              ...pm,
              type: pm.type || "machine",
              count: pm.count || 1,
            };
            if (pm.type === "purchasing_portal") {
              normalized.materialId = pm.materialId || null;
            }
            if (pm.type === "fuel_source") {
              normalized.fuelId = pm.fuelId || null;
            }
            if (pm.type === "nursery") {
              normalized.plantId = pm.plantId || null;
              normalized.fertilizerId = pm.fertilizerId || null;
            }
            // Storage machine (type === "machine" but machine.kind === "storage")
            if (pm.type === "machine" && pm.machineId) {
              // We'll check if it's a storage machine when rendering
              normalized.storageSlots = Number.isFinite(pm.storageSlots) && pm.storageSlots > 0 
                ? Math.trunc(pm.storageSlots) 
                : null;
              normalized.inventories = Array.isArray(pm.inventories) ? pm.inventories : [];
              normalized.manualInventories = Array.isArray(pm.manualInventories) ? pm.manualInventories : [];
              // Heating device machine (type === "machine" but machine.kind === "heating_device")
              normalized.toppers = Array.isArray(pm.toppers) ? pm.toppers : [];
              normalized.previewFuelId = typeof pm.previewFuelId === 'string' ? pm.previewFuelId : null;
            }
            return normalized;
          })
        : [];
      
      const connections = Array.isArray(parsed.connections) ? parsed.connections : [];
      
      // Load camera state or use defaults
      const camera = parsed.camera && typeof parsed.camera === 'object'
        ? {
            x: Number(parsed.camera.x) || 0,
            y: Number(parsed.camera.y) || 0,
            zoom: Number(parsed.camera.zoom) || 1.0
          }
        : { x: 0, y: 0, zoom: 1.0 };
      
      // Validate the build
      const issues = validateBuild(placedMachines, connections);
      if (issues.length > 0) {
        showValidationWarning(issues, 'saved build');
      }
      
      return { placedMachines, connections, camera };
    } catch {
      return { placedMachines: [], connections: [], camera: { x: 0, y: 0, zoom: 1.0 } };
    }
  }
  
  function saveSkills() {
    localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(state.skills, null, 2));
  }
  
  function saveUIPrefs() {
    const prefs = {
      sidebars: state.ui.sidebars,
    };
    localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs, null, 2));
  }
  
  function loadUIPrefs() {
    const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY);
    if (!raw) {
      return {
        sidebars: {
          database: true,
          blueprints: false,
          production: false,
        },
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        sidebars: parsed.sidebars || {
          database: true,
          blueprints: false,
          production: false,
        },
      };
    } catch {
      return {
        sidebars: {
          database: true,
          blueprints: false,
          production: false,
        },
      };
    }
  }
  
  function loadSkills() {
    const raw = localStorage.getItem(SKILLS_STORAGE_KEY);
    const defaults = {
      conveyorSpeed: 0,
      throwingSpeed: 0,
      machineEfficiency: 0,
      alchemyEfficiency: 0,
      fuelEfficiency: 0,
      fertilizerEfficiency: 0,
      shopProfit: 0,
    };
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      return {
        conveyorSpeed: Number(parsed.conveyorSpeed) || 0,
        throwingSpeed: Number(parsed.throwingSpeed) || 0,
        machineEfficiency: Number(parsed.machineEfficiency) || 0,
        alchemyEfficiency: Number(parsed.alchemyEfficiency) || 0,
        fuelEfficiency: Number(parsed.fuelEfficiency) || 0,
        fertilizerEfficiency: Number(parsed.fertilizerEfficiency) || 0,
        shopProfit: Number(parsed.shopProfit) || 0,
      };
    } catch {
      return defaults;
    }
  }
  
  // ---------- Skill Calculation Helpers ----------
  
  /**
   * Get effective conveyor speed with skill bonus
   * Base: 60/min, +15/min per skill point
   */
  function getConveyorSpeed() {
    return CONVEYOR_SPEED + (state.skills.conveyorSpeed * 15);
  }
  
  /**
   * Get effective throwing speed with skill bonus
   * Base: 60/min, +15/min per skill point
   */
  function getThrowingSpeed() {
    return CONVEYOR_SPEED + (state.skills.throwingSpeed * 15);
  }
  
  /**
   * Get effective processing time with machine efficiency skill
   * Each point reduces time by 25% (multiplicative)
   * @param {number} baseTimeInSec - Base processing time in seconds
   * @returns {number} Adjusted processing time
   */
  function getFactoryEfficiency(baseTimeInSec) {
    // Reduce time by 25% per point: time * (1 - 0.25 * skill)
    const reduction = state.skills.machineEfficiency * 0.25;
    return baseTimeInSec * (1 - Math.min(reduction, 1)); // Cap at 95% reduction
  }
  
  /**
   * Get fuel consumption rate with skill adjustment
   * Each Machine Efficiency point increases consumption by 25%
   * @param {number} baseConsumptionP - Base consumption rate in Pyra/P per second
   * @returns {number} Adjusted consumption rate in Pyra/P per second
   */
  function getFuelConsumptionRate(baseConsumptionP) {
    return baseConsumptionP * (1 + (0.25 * state.skills.machineEfficiency));
  }
  
  /**
   * Get fuel Heat Value with skill adjustment
   * Each point increases fuel value by 10%
   * @param {number} totalBaseP - Base Heat Value in Pyra/P
   * @returns {number} Adjusted Heat Value in Pyra/P
   */
  function getFuelHeatValue(totalBaseP) {
    return totalBaseP * (1 + (0.10 * state.skills.fuelEfficiency));
  }
  
  /**
   * Get fertilizer value with skill adjustment
   * Each point increases value by 10%
   * @param {number} totalBaseV - Base fertilizer value
   * @returns {number} Adjusted fertilizer value
   */
  function getFertilizerValue(totalBaseV) {
    return totalBaseV * (1 + (0.10 * state.skills.fertilizerEfficiency));
  }
  
  /**
   * Get profit with skill adjustment
   * Each point increases profit by 3%
   * @param {number} basePriceC - Base price in coins
   * @returns {number} Adjusted price
   */
  function getProfit(basePriceC) {
    return basePriceC * (1 + (0.03 * state.skills.shopProfit));
  }
  
  /**
   * Get alchemy efficiency (extractor output bonus)
   * Each point adds 3% output
   * @param {number} baseOutput - Base output amount
   * @returns {number} Adjusted output
   */
  function getAlchemyEfficiency(baseOutput) {
    return baseOutput * (1 + (0.03 * state.skills.alchemyEfficiency));
  }
  
  // Legacy aliases for backward compatibility
  function getEffectiveConveyorSpeed() {
    return getConveyorSpeed();
  }
  
  function getEffectiveProcessingTime(baseTime) {
    return getFactoryEfficiency(baseTime);
  }

  function normalizeDb(db) {
    if (!db || typeof db !== "object") return createEmptyDb();
    const normalized = {
      version: SCHEMA_VERSION,
      meta: {
        createdAt: typeof db.meta?.createdAt === "string" ? db.meta.createdAt : new Date().toISOString(),
        updatedAt: typeof db.meta?.updatedAt === "string" ? db.meta.updatedAt : new Date().toISOString(),
      },
      materials: Array.isArray(db.materials) ? db.materials : [],
      machines: Array.isArray(db.machines) ? db.machines : [],
      recipes: Array.isArray(db.recipes) ? db.recipes : [],
      blueprints: Array.isArray(db.blueprints) ? db.blueprints : [],
    };
    // Ensure required fields minimally exist for each item
    normalized.materials = normalized.materials
      .filter((m) => m && typeof m === "object")
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : makeId("mat"),
        name: typeof m.name === "string" ? m.name : "Unnamed Material",
        buyPrice: Number.isFinite(m.buyPrice) ? m.buyPrice : null,
        salePrice: Number.isFinite(m.salePrice) ? m.salePrice : null,
        isFuel: Boolean(m.isFuel),
        fuelValue: Number.isFinite(m.fuelValue) ? m.fuelValue : null,
        isFertilizer: Boolean(m.isFertilizer),
        fertilizerNutrientValue: Number.isFinite(m.fertilizerNutrientValue) ? m.fertilizerNutrientValue : null,
        fertilizerMaxFertility: Number.isFinite(m.fertilizerMaxFertility) ? m.fertilizerMaxFertility : null,
        isPlant: Boolean(m.isPlant),
        plantRequiredNutrient: Number.isFinite(m.plantRequiredNutrient) ? m.plantRequiredNutrient : null,
        stackSize: Number.isFinite(m.stackSize) && m.stackSize > 0 ? Math.trunc(m.stackSize) : 1,
      }));
    normalized.machines = normalized.machines
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        // Migrate old "furnace" to "heating_device"
        let kind = x.kind;
        if (kind === "furnace") kind = "heating_device";
        if (!["standard", "heating_device", "storage", "nursery"].includes(kind)) kind = "standard";
        
        return {
          id: typeof x.id === "string" ? x.id : makeId("mac"),
          name: typeof x.name === "string" ? x.name : "Unnamed Machine",
          inputs: Number.isFinite(x.inputs) ? Math.max(0, Math.trunc(x.inputs)) : 0,
          outputs: Number.isFinite(x.outputs) ? Math.max(0, Math.trunc(x.outputs)) : 0,
          requiresFurnace: Boolean(x.requiresFurnace),
          heatConsumptionP: Number.isFinite(x.heatConsumptionP) ? Number(x.heatConsumptionP) : null,
          kind: kind,
          baseHeatConsumptionP:
            kind === "heating_device" && Number.isFinite(x.baseHeatConsumptionP) ? Number(x.baseHeatConsumptionP) : 1,
          storageSlots: kind === "storage" && Number.isFinite(x.storageSlots) && x.storageSlots > 0 
            ? Math.trunc(x.storageSlots) 
            : null,
          // Heating device fields
          heatingAreaWidth: kind === "heating_device" && Number.isFinite(x.heatingAreaWidth) && x.heatingAreaWidth > 0
            ? Math.trunc(x.heatingAreaWidth)
            : null,
          heatingAreaLength: kind === "heating_device" && Number.isFinite(x.heatingAreaLength) && x.heatingAreaLength > 0
            ? Math.trunc(x.heatingAreaLength)
            : null,
          // Footprint fields for machines that require heating devices
          footprintWidth: x.requiresFurnace && Number.isFinite(x.footprintWidth) && x.footprintWidth > 0
            ? Math.trunc(x.footprintWidth)
            : null,
          footprintLength: x.requiresFurnace && Number.isFinite(x.footprintLength) && x.footprintLength > 0
            ? Math.trunc(x.footprintLength)
            : null,
        };
      });
    normalized.recipes = normalized.recipes
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        id: typeof r.id === "string" ? r.id : makeId("rec"),
        name: typeof r.name === "string" ? r.name : "Unnamed Recipe",
        machineId: typeof r.machineId === "string" ? r.machineId : "",
        processingTimeSec: Number.isFinite(r.processingTimeSec) ? Math.max(0.0001, Number(r.processingTimeSec)) : 1,
        inputs: Array.isArray(r.inputs) ? r.inputs : [],
        outputs: Array.isArray(r.outputs) ? r.outputs : [],
        heatConsumptionP: Number.isFinite(r.heatConsumptionP) ? Number(r.heatConsumptionP) : null,
      }))
      .map((r) => ({
        ...r,
        inputs: normalizeIoList(r.inputs),
        outputs: normalizeIoList(r.outputs),
      }));
    return normalized;
  }

  function normalizeIoList(list) {
    return list
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        materialId: typeof x.materialId === "string" ? x.materialId : "",
        items: Number.isFinite(x.items) ? Number(x.items) : (Number.isFinite(x.ppm) ? Number(x.ppm) : 0), // backward compat: ppm → items
      }));
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function exportDb() {
    const content = JSON.stringify(state.db, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alchemy-factory-db-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Exported database JSON.");
  }
  
  /**
   * Export entire state (database + build + skills)
   */
  function exportFullState() {
    const fullState = {
      version: 1,
      database: state.db,
      build: {
        placedMachines: state.build.placedMachines,
        connections: state.build.connections,
        camera: state.build.camera
      },
      skills: state.skills
    };
    
    const content = JSON.stringify(fullState, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `alchemy-factory-full-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Exported full state (database + build + skills).");
  }
  
  /**
   * Import full state with validation
   */
  async function importFullState(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    
    // Check if this is a full state export or just database
    if (parsed.version && parsed.database && parsed.build) {
      // Full state import
      state.db = normalizeDb(parsed.database);
      saveDb();
      
      // Validate build before importing
      const placedMachines = Array.isArray(parsed.build.placedMachines) ? parsed.build.placedMachines : [];
      const connections = Array.isArray(parsed.build.connections) ? parsed.build.connections : [];
      
      const issues = validateBuild(placedMachines, connections);
      if (issues.length > 0) {
        showValidationWarning(issues, 'imported file');
      }
      
      state.build.placedMachines = placedMachines;
      state.build.connections = connections;
      state.build.selectedMachines = [];
      
      // Import camera if present, otherwise use defaults
      if (parsed.build.camera && typeof parsed.build.camera === 'object') {
        state.build.camera = {
          x: Number(parsed.build.camera.x) || 0,
          y: Number(parsed.build.camera.y) || 0,
          zoom: Number(parsed.build.camera.zoom) || 1.0
        };
      } else {
        state.build.camera = { x: 0, y: 0, zoom: 1.0 };
      }
      
      saveBuild();
      
      // Import skills if present
      if (parsed.skills) {
        state.skills = parsed.skills;
        saveSkills();
      }
      
      state.ui.selected.materials = null;
      state.ui.selected.machines = null;
      renderAll();
      setStatus("Imported full state with validation.", "ok");
    } else {
      // Legacy database-only import
      state.db = normalizeDb(parsed);
      saveDb();
      state.ui.selected.materials = null;
      state.ui.selected.machines = null;
      renderAll();
      setStatus("Imported database JSON.", "ok");
    }
  }

  async function importDbFromFile(file) {
    // Use the new importFullState which handles both formats
    await importFullState(file);
  }
  
  /**
   * Manually validate current build and show issues
   */
  function validateCurrentBuild() {
    const issues = validateBuild(state.build.placedMachines, state.build.connections);
    if (issues.length === 0) {
      alert('✅ No validation issues found!\n\nYour build is valid.');
      console.log('✅ Build validation passed - no issues found');
    } else {
      showValidationWarning(issues, 'current build');
      console.group('🔍 Build Validation Issues');
      issues.forEach(issue => {
        console.warn(issue.message, issue);
      });
      console.groupEnd();
    }
  }

  function clearDb() {
    state.db = createEmptyDb();
    saveDb();
    state.ui.selected.materials = null;
    state.ui.selected.machines = null;
    renderAll();
    setStatus("Cleared local database.", "info");
  }

  // ---------- Query helpers ----------

  function getMaterialById(id) {
    return state.db.materials.find((m) => m.id === id) ?? null;
  }
  function getMachineById(id) {
    return state.db.machines.find((m) => m.id === id) ?? null;
  }
  function getRecipeById(id) {
    return state.db.recipes.find((r) => r.id === id) ?? null;
  }

  function compareByName(a, b) {
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }

  function filterByName(list, q) {
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((x) => String(x.name ?? "").toLowerCase().includes(s));
  }

  function materialLabel(matId) {
    const m = getMaterialById(matId);
    return m ? m.name : "(missing material)";
  }

  /**
   * Parse a time string in format like "2m30s", "1m", "45s", or plain "120" (seconds)
   * Returns the total time in seconds, or null if invalid.
   */
  function parseTimeString(str) {
    if (!str) return null;
    str = String(str).trim().toLowerCase();
    
    // Try plain number first
    const plainNum = parseFloat(str);
    if (!isNaN(plainNum) && /^\d+\.?\d*$/.test(str)) {
      return plainNum > 0 ? plainNum : null;
    }
    
    // Parse format like "2m30s", "1m", "45s"
    let totalSeconds = 0;
    
    // Match minutes
    const minutesMatch = str.match(/(\d+\.?\d*)m/);
    if (minutesMatch) {
      totalSeconds += parseFloat(minutesMatch[1]) * 60;
    }
    
    // Match seconds
    const secondsMatch = str.match(/(\d+\.?\d*)s/);
    if (secondsMatch) {
      totalSeconds += parseFloat(secondsMatch[1]);
    }
    
    // If we found neither minutes nor seconds in the format, it's invalid
    if (!minutesMatch && !secondsMatch) {
      return null;
    }
    
    return totalSeconds > 0 ? totalSeconds : null;
  }

  /**
   * Format seconds into a readable time string like "2m30s", "1m", "45s", or just "120s"
   */
  function formatTimeString(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
    
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    
    if (minutes > 0 && secs > 0) {
      // Remove trailing zeros after decimal point
      const secsStr = secs % 1 === 0 ? secs : secs.toFixed(2).replace(/\.?0+$/, '');
      return `${minutes}m${secsStr}s`;
    } else if (minutes > 0) {
      return `${minutes}m`;
    } else {
      const secsStr = secs % 1 === 0 ? secs : secs.toFixed(2).replace(/\.?0+$/, '');
      return `${secsStr}s`;
    }
  }

  /**
   * Get detailed information about why a cost can't be calculated
   */
  function getCostCalculationDetails(materialId, depth = 0) {
    const material = getMaterialById(materialId);
    if (!material) return { canCalculate: false, reason: "Material not found" };
    
    const details = {
      materialName: material.name,
      hasBuyPrice: material.buyPrice != null,
      buyPrice: material.buyPrice,
      producingRecipes: [],
      canCalculate: false,
      reason: null,
    };
    
    // Check if material has a buy price
    if (details.hasBuyPrice) {
      details.canCalculate = true;
      return details;
    }
    
    // Check producing recipes
    const recipes = state.db.recipes.filter(r => 
      r.outputs.some(out => out.materialId === materialId)
    );
    
    if (recipes.length === 0) {
      details.reason = "No buy price and no recipes produce this material";
      return details;
    }
    
    for (const recipe of recipes) {
      const recipeInfo = {
        recipeName: recipe.name,
        inputs: [],
        canUse: true,
        reason: null,
      };
      
      for (const input of recipe.inputs) {
        if (!input.materialId) {
          recipeInfo.canUse = false;
          recipeInfo.reason = "Recipe has an input with no material selected";
          break;
        }
        
        if (!input.items || input.items <= 0) {
          recipeInfo.canUse = false;
          recipeInfo.reason = `Input "${getMaterialById(input.materialId)?.name || 'unknown'}" has 0 or negative items`;
          break;
        }
        
        const inputMat = getMaterialById(input.materialId);
        const inputCost = calculateRealizedCost(input.materialId);
        recipeInfo.inputs.push({
          materialName: inputMat?.name || "unknown",
          items: input.items,
          cost: inputCost,
          canCalculate: Number.isFinite(inputCost),
        });
        
        if (!Number.isFinite(inputCost)) {
          recipeInfo.canUse = false;
          recipeInfo.reason = `Input "${inputMat?.name || 'unknown'}" has no calculable cost`;
        }
      }
      
      details.producingRecipes.push(recipeInfo);
      if (recipeInfo.canUse) {
        details.canCalculate = true;
      }
    }
    
    if (!details.canCalculate && details.producingRecipes.length > 0) {
      details.reason = "All producing recipes have issues (check inputs)";
    }
    
    return details;
  }

  /**
   * Calculate the realized cost of a material.
   * This is the minimum of:
   * - The buy price (if available)
   * - The production cost from any recipe that produces it
   * 
   * Uses memoization and cycle detection to handle complex recipe chains.
   */
  function calculateRealizedCost(materialId, visitedSet = new Set(), memo = new Map()) {
    // Check memo first
    if (memo.has(materialId)) {
      return memo.get(materialId);
    }
    
    // Detect circular dependencies
    if (visitedSet.has(materialId)) {
      return Infinity; // Circular dependency, can't calculate
    }
    
    const material = getMaterialById(materialId);
    if (!material) return Infinity;
    
    let minCost = Infinity;
    
    // Option 1: Buy price
    if (material.buyPrice != null && material.buyPrice >= 0) {
      minCost = material.buyPrice;
    }
    
    // Option 2: Production cost from recipes
    const producingRecipes = state.db.recipes.filter(r => 
      r.outputs.some(out => out.materialId === materialId)
    );
    
    visitedSet.add(materialId);
    
    for (const recipe of producingRecipes) {
      // Calculate total input cost
      let inputCost = 0;
      let canCalculate = true;
      
      // Skip recipes with no inputs or empty recipe
      if (!recipe.inputs || recipe.inputs.length === 0) {
        continue;
      }
      
      for (const input of recipe.inputs) {
        // Skip inputs with no material selected
        if (!input.materialId) {
          canCalculate = false;
          break;
        }
        
        // Skip inputs with 0 or negative items (invalid recipe configuration)
        if (!input.items || input.items <= 0) {
          canCalculate = false;
          break;
        }
        
        // Recursively calculate the cost of this input material
        const inputMaterialCost = calculateRealizedCost(input.materialId, new Set(visitedSet), memo);
        
        // If any input material has no calculable cost, skip this recipe
        if (!Number.isFinite(inputMaterialCost)) {
          canCalculate = false;
          break;
        }
        
        // Add this input's cost to the total
        inputCost += inputMaterialCost * input.items;
      }
      
      if (!canCalculate) continue;
      
      // Find the output quantity for this material in this recipe
      const output = recipe.outputs.find(out => out.materialId === materialId);
      if (output && output.items > 0) {
        const costPerUnit = inputCost / output.items;
        minCost = Math.min(minCost, costPerUnit);
      }
    }
    
    visitedSet.delete(materialId);
    
    // Memoize and return
    memo.set(materialId, minCost);
    return minCost;
  }

  // ---------- Rendering ----------

  function renderAll() {
    renderTabs();
    renderMaterials();
    renderMachines();
    renderSkillsBar();
    renderBlueprintsList();
    updateCreateBlueprintButton();
  }

  function renderTabs() {
    $$(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === state.ui.activeTab));
    $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== state.ui.activeTab));
  }

  function renderMaterials() {
    const listEl = $("#materialsList");
    const editorEl = $("#materialEditor");
    const currentEl = $('[data-dropdown-toggle="materials"]');
    if (!listEl || !editorEl || !currentEl) return;
    
    const q = state.ui.filters.materials;
    const items = filterByName([...state.db.materials].sort(compareByName), q);
    listEl.innerHTML = items
      .map((m) => {
        const selected = state.ui.selected.materials === m.id ? " is-selected" : "";
        const metaParts = [];
        
        // Calculate realized cost
        const realizedCost = calculateRealizedCost(m.id);
        if (Number.isFinite(realizedCost)) {
          metaParts.push(`Cost: ${realizedCost.toFixed(2)}`);
        } else {
          metaParts.push(`Cost: —`);
        }
        
        if (m.buyPrice != null) metaParts.push(`Buy: ${m.buyPrice}`);
        if (m.salePrice != null) metaParts.push(`Sell: ${m.salePrice}`);
        if (m.isFuel) metaParts.push(`Fuel (${m.fuelValue ?? "?"}P)`);
        if (m.isFertilizer) metaParts.push(`Fertilizer (${m.fertilizerNutrientValue ?? "?"}V, ${m.fertilizerMaxFertility ?? "?"}V/s)`);
        if (m.isPlant) metaParts.push(`Plant (${m.plantRequiredNutrient ?? "?"}V)`);
        return `
          <div class="listItem${selected}" data-kind="materials" data-id="${escapeHtml(m.id)}" tabindex="0">
            <div class="listItem__title">${escapeHtml(m.name)}</div>
            <div class="listItem__meta">${escapeHtml(metaParts.join(" • ") || "—")}</div>
          </div>
        `;
      })
      .join("");

    // Update current selection display
    const selectedId = state.ui.selected.materials;
    const selected = selectedId ? getMaterialById(selectedId) : null;
    if (selected) {
      const metaParts = [];
      const realizedCost = calculateRealizedCost(selected.id);
      if (Number.isFinite(realizedCost)) metaParts.push(`Cost: ${realizedCost.toFixed(2)}`);
      else metaParts.push(`Cost: —`);
      if (selected.buyPrice != null) metaParts.push(`Buy: ${selected.buyPrice}`);
      if (selected.salePrice != null) metaParts.push(`Sell: ${selected.salePrice}`);
      if (selected.isFuel) metaParts.push(`Fuel (${selected.fuelValue ?? "?"}P)`);
      if (selected.isFertilizer) metaParts.push(`Fert (${selected.fertilizerNutrientValue ?? "?"}V)`);
      if (selected.isPlant) metaParts.push(`Plant (${selected.plantRequiredNutrient ?? "?"}V)`);
      
      currentEl.innerHTML = `
        <div class="dropdownSelector__selectedItem">
          <div class="dropdownSelector__selectedTitle">${escapeHtml(selected.name)}</div>
          <div class="dropdownSelector__selectedMeta">${escapeHtml(metaParts.join(" • ") || "—")}</div>
        </div>
        <div class="dropdownSelector__arrow">▼</div>
      `;
    } else {
      currentEl.innerHTML = `
        <div class="dropdownSelector__placeholder">Select a material...</div>
        <div class="dropdownSelector__arrow">▼</div>
      `;
    }
    
    editorEl.innerHTML = selected ? renderMaterialForm(selected) : `<div class="emptyState">Select a material or click "Add".</div>`;
  }

  function renderMaterialForm(m) {
    const template = $("#materialFormTemplate");
    if (!template) return "";
    // Clone the entire template content (form + recipes section)
    const fragment = template.content.cloneNode(true);
    const form = fragment.querySelector("form");
    
    form.dataset.id = m.id;
    form.querySelector('[data-bind="name"]').setAttribute("value", m.name);
    form.querySelector('[data-bind="fuelValue"]').setAttribute("value", m.fuelValue ?? "");
    form.querySelector('[data-bind="buyPrice"]').setAttribute("value", m.buyPrice ?? "");
    form.querySelector('[data-bind="salePrice"]').setAttribute("value", m.salePrice ?? "");
    form.querySelector('[data-bind="stackSize"]').setAttribute("value", m.stackSize ?? 1);
    if (m.isFuel) form.querySelector('[data-bind="isFuel"]').setAttribute("checked", "");
    if (m.isFertilizer) form.querySelector('[data-bind="isFertilizer"]').setAttribute("checked", "");
    if (m.isPlant) form.querySelector('[data-bind="isPlant"]').setAttribute("checked", "");
    form.querySelector('[data-bind="fertilizerNutrientValue"]').setAttribute("value", m.fertilizerNutrientValue ?? "");
    form.querySelector('[data-bind="fertilizerMaxFertility"]').setAttribute("value", m.fertilizerMaxFertility ?? "");
    form.querySelector('[data-bind="plantRequiredNutrient"]').setAttribute("value", m.plantRequiredNutrient ?? "");
    
    // Show/hide fertilizer and plant fields based on checkboxes
    const fertilizerFields = form.querySelector('[data-fertilizer-fields]');
    const plantField = form.querySelector('[data-plant-field]');
    if (fertilizerFields) fertilizerFields.style.display = m.isFertilizer ? "" : "none";
    if (plantField) plantField.style.display = m.isPlant ? "" : "none";
    
    // Calculate and display realized cost
    const realizedCost = calculateRealizedCost(m.id);
    const costEl = form.querySelector('[data-bind="realizedCost"]');
    if (costEl) {
      if (Number.isFinite(realizedCost)) {
        costEl.textContent = `${realizedCost.toFixed(4)} copper coins`;
      } else {
        // Show detailed breakdown of why cost can't be calculated
        const details = getCostCalculationDetails(m.id);
        let message = "Cannot calculate cost";
        if (details.reason) {
          message += `: ${details.reason}`;
        }
        if (details.producingRecipes.length > 0) {
          message += "\n\nRecipe issues:";
          details.producingRecipes.forEach(r => {
            message += `\n• ${r.recipeName}: ${r.reason || "OK"}`;
            if (r.inputs.length > 0) {
              r.inputs.forEach(inp => {
                if (!inp.canCalculate) {
                  message += `\n  - ${inp.materialName} (${inp.items}x): No cost available`;
                }
              });
            }
          });
        }
        costEl.textContent = message;
        costEl.style.whiteSpace = "pre-wrap";
      }
    }
    
    // Populate recipes that produce this material (in the fragment, not the form)
    const recipesList = fragment.querySelector('[data-recipes-list]');
    if (recipesList) {
      const producingRecipes = state.db.recipes.filter(r => 
        r.outputs.some(out => out.materialId === m.id)
      );
      
      if (producingRecipes.length === 0) {
        recipesList.innerHTML = `<div class="emptyState" style="margin-top: 0;">No recipes produce this material yet.</div>`;
      } else {
        recipesList.innerHTML = producingRecipes
          .map(recipe => renderRecipeCard(recipe, m.id))
          .join("");
      }
    }
    
    // Create a wrapper div to convert the fragment to HTML string
    const wrapper = document.createElement('div');
    wrapper.appendChild(fragment);
    return wrapper.innerHTML;
  }
  
  function renderRecipeCard(recipe, contextMaterialId) {
    const template = $("#recipeCardTemplate");
    if (!template) return "";
    const card = template.content.cloneNode(true).querySelector(".recipeCard");
    
    const machine = recipe.machineId ? getMachineById(recipe.machineId) : null;
    const machineName = machine ? machine.name : "(no machine)";
    const time = formatTimeString(recipe.processingTimeSec);
    
    card.dataset.recipeId = recipe.id;
    card.dataset.contextMaterialId = contextMaterialId;
    
    card.querySelector('[data-bind="recipeName"]').textContent = recipe.name;
    card.querySelector('[data-bind="recipeMeta"]').textContent = `${machineName} • ${recipe.inputs.length} in • ${recipe.outputs.length} out • ${time}`;
    
    // Populate the recipe form body
    const body = card.querySelector('[data-recipe-body]');
    body.innerHTML = renderRecipeForm(recipe);
    
    // Update delete button to reference this specific recipe
    const deleteBtn = card.querySelector('[data-action="recipe:delete"]');
    if (deleteBtn) {
      deleteBtn.dataset.recipeId = recipe.id;
    }
    
    return card.outerHTML;
  }

  function renderMachines() {
    const listEl = $("#machinesList");
    const editorEl = $("#machineEditor");
    const currentEl = $('[data-dropdown-toggle="machines"]');
    if (!listEl || !editorEl || !currentEl) return;
    
    const q = state.ui.filters.machines;
    const items = filterByName([...state.db.machines].sort(compareByName), q);
    listEl.innerHTML = items
      .map((m) => {
        const selected = state.ui.selected.machines === m.id ? " is-selected" : "";
        let meta = `${m.inputs} in • ${m.outputs} out`;
        if (m.kind === "heating_device") meta = furnaceMeta(m);
        if (m.kind === "storage") meta = `${m.storageSlots} slots • ${m.inputs} in • ${m.outputs} out`;
        return `
          <div class="listItem${selected}" data-kind="machines" data-id="${escapeHtml(m.id)}" tabindex="0">
            <div class="listItem__title">${escapeHtml(m.name)}</div>
            <div class="listItem__meta">${escapeHtml(meta)}</div>
          </div>
        `;
      })
      .join("");

    // Update current selection display
    const selectedId = state.ui.selected.machines;
    const selected = selectedId ? getMachineById(selectedId) : null;
    if (selected) {
      let meta = `${selected.inputs} in • ${selected.outputs} out`;
      if (selected.kind === "heating_device") meta = furnaceMeta(selected);
      if (selected.kind === "storage") meta = `${selected.storageSlots} slots • ${selected.inputs} in • ${selected.outputs} out`;
      currentEl.innerHTML = `
        <div class="dropdownSelector__selectedItem">
          <div class="dropdownSelector__selectedTitle">${escapeHtml(selected.name)}</div>
          <div class="dropdownSelector__selectedMeta">${escapeHtml(meta)}</div>
        </div>
        <div class="dropdownSelector__arrow">▼</div>
      `;
    } else {
      currentEl.innerHTML = `
        <div class="dropdownSelector__placeholder">Select a machine...</div>
        <div class="dropdownSelector__arrow">▼</div>
      `;
    }
    
    editorEl.innerHTML = selected ? renderMachineForm(selected) : `<div class="emptyState">Select a machine or click "Add".</div>`;
  }

  function furnaceMeta(m) {
    const baseHeat = Number.isFinite(m.baseHeatConsumptionP) ? m.baseHeatConsumptionP : 1;
    return `Furnace • ${m.inputs} in • ${m.outputs} out • Base: ${baseHeat}P/s`;
  }

  function renderSkillsBar() {
    const skillsBar = $("#skillsBar");
    if (!skillsBar) return;
    
    const skills = [
      { key: "conveyorSpeed", icon: "⚙️", abbr: "CVY", title: "Conveyor Speed" },
      { key: "throwingSpeed", icon: "🤚", abbr: "THR", title: "Throwing Speed" },
      { key: "machineEfficiency", icon: "🔧", abbr: "MCH", title: "Machine Efficiency" },
      { key: "alchemyEfficiency", icon: "⚗️", abbr: "ALC", title: "Alchemy Efficiency" },
      { key: "fuelEfficiency", icon: "🔥", abbr: "FUL", title: "Fuel Efficiency" },
      { key: "fertilizerEfficiency", icon: "🌱", abbr: "FRT", title: "Fertilizer Efficiency" },
      { key: "shopProfit", icon: "💰", abbr: "SHP", title: "Shop Profit" },
    ];
    
    skillsBar.innerHTML = skills.map(skill => {
      const value = state.skills[skill.key] || 0;
      return `
        <div class="skillsBar__item" title="${skill.title}: ${value} points" data-action="edit:skills">
          <span class="skillsBar__icon">${skill.icon}</span>
          <span class="skillsBar__abbr">${skill.abbr}</span>
          <span class="skillsBar__value">${value}</span>
        </div>
      `;
    }).join("");
  }

  function renderMachineForm(m) {
    const template = $("#machineFormTemplate");
    if (!template) return "";
    const form = template.content.cloneNode(true).querySelector("form");
    
    const isHeatingDevice = m.kind === "heating_device";
    const isStorage = m.kind === "storage";
    const requiresFurnace = Boolean(m.requiresFurnace);
    
    form.dataset.id = m.id;
    form.querySelector('[data-bind="name"]').setAttribute("value", m.name);
    
    // Set kind select
    const kindSelect = form.querySelector('[data-bind="kind"]');
    kindSelect.querySelectorAll("option").forEach(opt => {
      if (opt.value === m.kind) opt.setAttribute("selected", "");
    });
    
    form.querySelector('[data-bind="inputs"]').setAttribute("value", String(m.inputs));
    form.querySelector('[data-bind="outputs"]').setAttribute("value", String(m.outputs));
    
    // Show/hide sections based on kind
    const stdSection = form.querySelector('[data-standard-section]');
    const heatingDeviceSection = form.querySelector('[data-heating-device-section]');
    const storageSection = form.querySelector('[data-storage-section]');
    
    stdSection.classList.toggle("hidden", isHeatingDevice || isStorage);
    heatingDeviceSection.classList.toggle("hidden", !isHeatingDevice);
    storageSection.classList.toggle("hidden", !isStorage);
    
    // Standard section fields
    if (requiresFurnace) form.querySelector('[data-bind="requiresFurnace"]').setAttribute("checked", "");
    const heatInput = form.querySelector('[data-bind="heatConsumptionP"]');
    heatInput.setAttribute("value", m.heatConsumptionP ?? "");
    if (!requiresFurnace) heatInput.setAttribute("disabled", "");
    form.querySelector('[data-bind="footprintWidth"]').setAttribute("value", String(m.footprintWidth ?? ""));
    form.querySelector('[data-bind="footprintLength"]').setAttribute("value", String(m.footprintLength ?? ""));
    
    // Heating Device section
    form.querySelector('[data-bind="baseHeatConsumptionP"]').setAttribute("value", String(m.baseHeatConsumptionP ?? 1));
    form.querySelector('[data-bind="heatingAreaWidth"]').setAttribute("value", String(m.heatingAreaWidth ?? ""));
    form.querySelector('[data-bind="heatingAreaLength"]').setAttribute("value", String(m.heatingAreaLength ?? ""));
    
    // Storage section
    form.querySelector('[data-bind="storageSlots"]').setAttribute("value", String(m.storageSlots ?? ""));
    
    return form.outerHTML;
  }

  function renderRecipeForm(r) {
    const template = $("#recipeFormTemplate");
    if (!template) return "";
    const form = template.content.cloneNode(true).querySelector("form");
    
    // Auto-populate inputs/outputs based on selected machine
    const machine = r.machineId ? getMachineById(r.machineId) : null;
    const numInputs = machine ? machine.inputs : 1;
    const numOutputs = machine ? machine.outputs : 1;
    
    // Pad or truncate to match machine spec
    const inputs = [];
    for (let i = 0; i < numInputs; i++) {
      inputs.push(r.inputs[i] || { materialId: "", items: 0 });
    }
    const outputs = [];
    for (let i = 0; i < numOutputs; i++) {
      outputs.push(r.outputs[i] || { materialId: "", items: 0 });
    }
    
    form.dataset.id = r.id;
    form.querySelector('[data-bind="name"]').setAttribute("value", r.name);
    form.querySelector('[data-bind="processingTimeSec"]').setAttribute("value", formatTimeString(r.processingTimeSec));
    form.querySelector('[data-bind="heatConsumptionP"]').setAttribute("value", r.heatConsumptionP ?? "");
    
    // Populate machine options
    const machineSelect = form.querySelector('[data-bind="machineId"]');
    populateMachineOptions(machineSelect, r.machineId);
    
    // Populate I/O rows
    const inputsList = form.querySelector('[data-io-list="inputs"]');
    const outputsList = form.querySelector('[data-io-list="outputs"]');
    
    inputs.forEach((io, idx) => {
      const row = renderIoRowElement("inputs", idx, io, r.processingTimeSec);
      inputsList.appendChild(row);
    });
    
    outputs.forEach((io, idx) => {
      const row = renderIoRowElement("outputs", idx, io, r.processingTimeSec);
      outputsList.appendChild(row);
    });
    
    return form.outerHTML;
  }

  function renderIoRowElement(kind, idx, io, processingTimeSec) {
    const template = $("#ioRowTemplate");
    if (!template) return document.createElement("div");
    const row = template.content.cloneNode(true).querySelector(".ioRow");
    
    const items = io.items ?? 0;
    const rate = processingTimeSec > 0 ? (items / processingTimeSec * 60).toFixed(2) : 0;
    
    row.dataset.ioRow = kind;
    row.dataset.idx = idx;
    
    const materialSelect = row.querySelector('[data-bind="materialId"]');
    materialSelect.name = `${kind}[${idx}].materialId`;
    populateMaterialOptions(materialSelect, io.materialId);
    
    const itemsInput = row.querySelector('[data-bind="items"]');
    itemsInput.name = `${kind}[${idx}].items`;
    itemsInput.setAttribute("value", String(items));
    
    row.querySelector('[data-bind="rateHint"]').textContent = `${rate} per minute`;
    
    return row;
  }

  function renderMaterialOptions(selectedId = "") {
    const mats = [...state.db.materials].sort(compareByName);
    return mats
      .map((m) => {
        const sel = m.id === selectedId ? " selected" : "";
        return `<option value="${escapeHtml(m.id)}"${sel}>${escapeHtml(m.name)}</option>`;
      })
      .join("");
  }

  function renderMachineOptions(selectedId = "") {
    const macs = [...state.db.machines].sort(compareByName);
    return macs
      .map((m) => {
        const sel = m.id === selectedId ? " selected" : "";
        const suffix =
          m.kind === "heating_device"
            ? " (Heating Device)"
            : m.kind === "storage"
            ? " (Storage)"
            : m.requiresFurnace
              ? " (requires Heating Device)"
              : "";
        return `<option value="${escapeHtml(m.id)}"${sel}>${escapeHtml(m.name + suffix)}</option>`;
      })
      .join("");
  }

  // Populate a <select> element with material options (DOM-based)
  function populateMaterialOptions(selectEl, selectedId = "") {
    const mats = [...state.db.materials].sort(compareByName);
    mats.forEach((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.name;
      if (m.id === selectedId) option.setAttribute("selected", "");
      selectEl.appendChild(option);
    });
  }

  // Populate a <select> element with machine options (DOM-based)
  function populateMachineOptions(selectEl, selectedId = "") {
    const macs = [...state.db.machines].sort(compareByName);
    macs.forEach((m) => {
      const option = document.createElement("option");
      option.value = m.id;
      const suffix =
        m.kind === "heating_device"
          ? " (Heating Device)"
          : m.kind === "storage"
          ? " (Storage)"
          : m.requiresFurnace
            ? " (requires Heating Device)"
            : "";
      option.textContent = m.name + suffix;
      if (m.id === selectedId) option.setAttribute("selected", "");
      selectEl.appendChild(option);
    });
  }

  // ---------- Event wiring ----------

  function wireMenus() {
    const onDocClick = (e) => {
      const menuBtn = e.target.closest?.("[data-menu]");
      if (menuBtn) {
        toggleMenu(menuBtn.dataset.menu);
        return;
      }

      const dropdownItem = e.target.closest?.("[data-action]");
      if (dropdownItem && dropdownItem.getAttribute("role") === "menuitem") {
        handleAction(dropdownItem.dataset.action);
        closeAllMenus();
        return;
      }

      // Click outside closes menus
      closeAllMenus();
    };

    document.addEventListener("click", onDocClick);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllMenus();
    });
  }

  function toggleMenu(name) {
    const btn = document.querySelector(`[data-menu="${name}"]`);
    const dd = document.querySelector(`[data-menu-dropdown="${name}"]`);
    if (!btn || !dd) return;
    const isOpen = btn.getAttribute("aria-expanded") === "true";
    closeAllMenus();
    if (!isOpen) {
      btn.setAttribute("aria-expanded", "true");
      dd.style.display = "block";
    }
  }

  function closeAllMenus() {
    $$("[data-menu]").forEach((b) => b.setAttribute("aria-expanded", "false"));
    $$("[data-menu-dropdown]").forEach((dd) => (dd.style.display = "none"));
  }

  function wireTabs() {
    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.ui.activeTab = btn.dataset.tab;
        renderTabs();
      });
    });
  }

  function wireSearch() {
    $("#materialSearch")?.addEventListener("input", (e) => {
      state.ui.filters.materials = e.target.value;
      renderMaterials();
    });
    $("#machineSearch")?.addEventListener("input", (e) => {
      state.ui.filters.machines = e.target.value;
      renderMachines();
    });
    $("#blueprintSelectionSearch")?.addEventListener("input", (e) => {
      renderBlueprintSelectionList(e.target.value);
    });
  }

  function wireAddButtons() {
    $("#addMaterialBtn")?.addEventListener("click", () => {
      const id = makeId("mat");
      state.db.materials.push({
        id,
        name: "New Material",
        buyPrice: null,
        salePrice: null,
        stackSize: 1,
        isFuel: false,
        fuelValue: null,
        isFertilizer: false,
        fertilizerNutrientValue: null,
        fertilizerMaxFertility: null,
        isPlant: false,
        plantRequiredNutrient: null,
      });
      state.ui.selected.materials = id;
      saveDb();
      renderMaterials();
      setStatus("Material added.");
    });

    $("#addMachineBtn")?.addEventListener("click", () => {
      const id = makeId("mac");
      state.db.machines.push({
        id,
        name: "New Machine",
        inputs: 1,
        outputs: 1,
        requiresFurnace: false,
        heatConsumptionP: null,
        kind: "standard",
        baseHeatConsumptionP: 1,
      });
      state.ui.selected.machines = id;
      saveDb();
      renderMachines();
      setStatus("Machine added.");
    });

  }

  function wireListsAndForms() {
    document.addEventListener("click", (e) => {
      // Handle blueprint edit action buttons in canvas subtitle
      const bpActionBtn = e.target.closest?.("#canvasSubtitle [data-action]");
      if (bpActionBtn) {
        const action = bpActionBtn.dataset.action;
        handleAction(action);
        return;
      }
      
      // Handle coordinates click (jump to coordinates)
      const coordsSpan = e.target.closest?.(".canvas__coords");
      if (coordsSpan) {
        openJumpToCoordinatesDialog();
        return;
      }
      
      // Handle dropdown toggle
      const dropdownToggle = e.target.closest?.("[data-dropdown-toggle]");
      if (dropdownToggle) {
        const kind = dropdownToggle.dataset.dropdownToggle;
        const dropdown = $(`[data-dropdown="${kind}"]`);
        const list = dropdown?.querySelector(".dropdownSelector__list");
        if (dropdown && list) {
          const isOpen = !list.classList.contains("hidden");
          // Close all dropdowns first
          $$(".dropdownSelector__list").forEach(l => l.classList.add("hidden"));
          $$(".dropdownSelector").forEach(d => d.classList.remove("is-open"));
          // Toggle this one
          if (!isOpen) {
            list.classList.remove("hidden");
            dropdown.classList.add("is-open");
          }
        }
        return;
      }
      
      // Handle recipe card toggle
      const recipeToggle = e.target.closest?.("[data-recipe-toggle]");
      if (recipeToggle) {
        const card = recipeToggle.closest(".recipeCard");
        if (card) {
          const body = card.querySelector(".recipeCard__body");
          if (body) {
            const isOpen = !body.classList.contains("hidden");
            body.classList.toggle("hidden");
            card.classList.toggle("is-open");
          }
        }
        return;
      }
      
      const listItem = e.target.closest?.(".listItem");
      if (listItem?.dataset?.kind && listItem?.dataset?.id) {
        const { kind, id } = listItem.dataset;
        state.ui.selected[kind] = id;
        
        // Close the dropdown
        const dropdown = $(`[data-dropdown="${kind}"]`);
        if (dropdown) {
          dropdown.querySelector(".dropdownSelector__list")?.classList.add("hidden");
          dropdown.classList.remove("is-open");
        }
        
        if (kind === "materials") renderMaterials();
        if (kind === "machines") renderMachines();
        return;
      }
      
      // Close dropdowns when clicking outside
      if (!e.target.closest?.(".dropdownSelector")) {
        $$(".dropdownSelector__list").forEach(l => l.classList.add("hidden"));
        $$(".dropdownSelector").forEach(d => d.classList.remove("is-open"));
      }

      // Handle storage type selection
      const storageTypeItem = e.target.closest?.("[data-storage-machine-id]");
      if (storageTypeItem) {
        const newMachineId = storageTypeItem.dataset.storageMachineId;
        
        // Check if we're replacing an existing storage
        const replacementId = state.ui.pendingStorageReplacementId;
        if (replacementId) {
          replaceStorageType(replacementId, newMachineId);
          closeDialog();
          state.ui.pendingStorageReplacementId = null;
          return;
        }
        
        // Otherwise, adding new storage to canvas
        const coords = state.ui.pendingStorageCoords;
        if (coords && newMachineId) {
          addStorageToCanvas(coords.x, coords.y, newMachineId);
          closeDialog();
          state.ui.pendingStorageCoords = null;
        }
        return;
      }
      
      // Handle blueprint selection
      const blueprintSelectItem = e.target.closest?.("[data-blueprint-select-id]");
      if (blueprintSelectItem) {
        const blueprintId = blueprintSelectItem.dataset.blueprintSelectId;
        const coords = state.ui.pendingBlueprintCoords;
        if (coords && blueprintId) {
          placeBlueprintOnCanvas(blueprintId, coords.x, coords.y);
          closeDialog();
          state.ui.pendingBlueprintCoords = null;
        }
        return;
      }
      
      // Handle dialog actions (like save buttons in dialogs)
      const dialogAction = e.target.closest?.("[data-action]");
      if (dialogAction && dialogAction.closest(".dialog")) {
        handleAction(dialogAction.dataset.action);
        return;
      }

      const actionBtn = e.target.closest?.("[data-action]");
      if (!actionBtn) return;
      
      // Skip menu items - they're handled by wireMenus()
      if (actionBtn.getAttribute("role") === "menuitem") return;

      const action = actionBtn.dataset.action;
      handleAction(action, actionBtn.dataset);
    });

    document.addEventListener("change", (e) => {
      // Machine kind selection - show/hide relevant sections
      const machineForm = e.target.closest?.('form[data-form="machine"]');
      if (machineForm && e.target.name === "kind") {
        const heatingDeviceSection = machineForm.querySelector("[data-heating-device-section]");
        const stdSection = machineForm.querySelector("[data-standard-section]");
        const storageSection = machineForm.querySelector("[data-storage-section]");
        
        const kind = e.target.value;
        const isHeatingDevice = kind === "heating_device";
        const isStorage = kind === "storage";
        
        heatingDeviceSection?.classList.toggle("hidden", !isHeatingDevice);
        storageSection?.classList.toggle("hidden", !isStorage);
        stdSection?.classList.toggle("hidden", isHeatingDevice || isStorage);
      }
      if (machineForm && e.target.name === "requiresFurnace") {
        const heat = machineForm.querySelector('input[name="heatConsumptionP"]');
        if (heat) heat.disabled = !e.target.checked;
      }
      
      // Material type checkboxes - mutually exclusive and show/hide fields
      const materialForm = e.target.closest?.('form[data-form="material"]');
      if (materialForm && (e.target.name === "isFuel" || e.target.name === "isFertilizer" || e.target.name === "isPlant")) {
        const fuelCheckbox = materialForm.querySelector('[name="isFuel"]');
        const fertilizerCheckbox = materialForm.querySelector('[name="isFertilizer"]');
        const plantCheckbox = materialForm.querySelector('[name="isPlant"]');
        const fertilizerFields = materialForm.querySelector('[data-fertilizer-fields]');
        const plantField = materialForm.querySelector('[data-plant-field]');
        
        // Enforce mutual exclusivity
        if (e.target.checked) {
          if (e.target.name === "isFuel") {
            fertilizerCheckbox.checked = false;
            plantCheckbox.checked = false;
          } else if (e.target.name === "isFertilizer") {
            fuelCheckbox.checked = false;
            plantCheckbox.checked = false;
          } else if (e.target.name === "isPlant") {
            fuelCheckbox.checked = false;
            fertilizerCheckbox.checked = false;
          }
        }
        
        // Show/hide fields based on checkboxes
        if (fertilizerFields) {
          fertilizerFields.style.display = fertilizerCheckbox.checked ? "" : "none";
        }
        if (plantField) {
          plantField.style.display = plantCheckbox.checked ? "" : "none";
        }
      }
      
      // Recipe machine selection: auto-populate inputs/outputs
      const recipeForm = e.target.closest?.('form[data-form="recipe"]');
      if (recipeForm && e.target.name === "machineId") {
        const recipeId = recipeForm.dataset.id;
        if (!recipeId) return;
        const recipe = getRecipeById(recipeId);
        if (!recipe) return;
        
        // Update recipe's machineId immediately (don't save yet)
        recipe.machineId = e.target.value;
        
        // Get the new machine's input/output counts
        const machine = getMachineById(e.target.value);
        const numInputs = machine ? machine.inputs : 1;
        const numOutputs = machine ? machine.outputs : 1;
        
        // Resize inputs/outputs arrays
        while (recipe.inputs.length < numInputs) recipe.inputs.push({ materialId: "", items: 0 });
        while (recipe.inputs.length > numInputs) recipe.inputs.pop();
        while (recipe.outputs.length < numOutputs) recipe.outputs.push({ materialId: "", items: 0 });
        while (recipe.outputs.length > numOutputs) recipe.outputs.pop();
        
        // Re-render only the I/O rows, not the entire form
        const processingTimeSec = parseTimeString(recipeForm.querySelector('[data-bind="processingTimeSec"]')?.value) || 0;
        
        const inputsList = recipeForm.querySelector('[data-io-list="inputs"]');
        const outputsList = recipeForm.querySelector('[data-io-list="outputs"]');
        
        if (inputsList) {
          inputsList.innerHTML = "";
          recipe.inputs.forEach((io, idx) => {
            const row = renderIoRowElement("inputs", idx, io, processingTimeSec);
            inputsList.appendChild(row);
          });
        }
        
        if (outputsList) {
          outputsList.innerHTML = "";
          recipe.outputs.forEach((io, idx) => {
            const row = renderIoRowElement("outputs", idx, io, processingTimeSec);
            outputsList.appendChild(row);
          });
        }
      }
    });

    document.addEventListener("submit", (e) => {
      const form = e.target.closest?.("form[data-form]");
      if (!form) return;
      e.preventDefault();

      const type = form.dataset.form;
      const id = form.dataset.id;
      if (!type || !id) return;

      if (type === "material") {
        onSaveMaterial(form, id);
        return;
      }
      if (type === "machine") {
        onSaveMachine(form, id);
        return;
      }
      if (type === "recipe") {
        onSaveRecipe(form, id);
      }
    });
  }

  function handleAction(action, data = {}) {
    switch (action) {
      case "file:new": {
        if (confirm("This will clear the local database stored in your browser. Continue?")) clearDb();
        return;
      }
      case "file:export":
        exportDb();
        return;
      case "file:export-full":
        exportFullState();
        return;
      case "file:import": {
        const input = $("#importFileInput");
        if (!input) return;
        input.value = "";
        input.click();
        return;
      }
      case "file:validate":
        validateCurrentBuild();
        return;
      case "file:clear-build": {
        if (confirm("Clear all machines and connections from the build canvas?")) {
          state.build.placedMachines = [];
          state.build.connections = [];
          state.build.selectedMachines = [];
          saveBuild();
          renderCanvas();
          setStatus("Build canvas cleared.");
        }
        return;
      }
      case "edit:skills":
        openSkillsDialog();
        return;
      case "dialog:close":
        closeDialog();
        return;
      case "skills:save":
        saveSkillsFromDialog();
        return;
      case "canvas:toggle-production":
        toggleProductionSidebar();
        return;
      case "canvas:reset-camera":
        state.build.camera = { x: 0, y: 0, zoom: 1.0 };
        saveBuild();
        renderCanvas();
        setStatus("Camera reset to origin.");
        return;
      case "canvas:center-all":
        centerAllMachinesAtOrigin();
        return;
      case "canvas:jump-to-coords":
        jumpToCoordinates();
        return;
      case "sidebar:toggle-database":
        toggleDatabaseSidebar();
        return;
      case "sidebar:toggle-blueprints":
        toggleBlueprintsSidebar();
        return;
      case "blueprint:create":
        openCreateBlueprintDialog();
        return;
      case "blueprint:save":
        saveBlueprintFromDialog();
        return;
      case "blueprint:delete":
        deleteBlueprint(data.blueprintDeleteId);
        return;
      case "blueprint:save-edit":
        saveBlueprintEdit();
        return;
      case "blueprint:save-as-new":
        saveBlueprintAsNew();
        return;
      case "blueprint:exit-edit":
        exitBlueprintEditMode();
        return;
      case "storage:save-manual":
        saveManualStorageMaterial();
        return;
      case "heating:save-topper":
        saveTopperFromDialog();
        return;
      case "material:delete":
        deleteSelected("materials");
        return;
      case "material:add-recipe":
        addRecipeForMaterial();
        return;
      case "machine:delete":
        deleteSelected("machines");
        return;
      case "machine:add-to-canvas":
        const machineId = state.ui.selected.machines;
        if (machineId) addMachineToCanvas(machineId);
        return;
      case "recipe:delete":
        deleteRecipe(data.recipeId);
        return;
      // recipe:add-io and recipe:remove-io no longer needed (auto-populated by machine)
      default:
        return;
    }
  }
  
  function addRecipeForMaterial() {
    const materialId = state.ui.selected.materials;
    if (!materialId) return;
    
    const material = getMaterialById(materialId);
    if (!material) return;
    
    const id = makeId("rec");
    state.db.recipes.push({
      id,
      name: `New ${material.name} Recipe`,
      machineId: "",
      processingTimeSec: 1,
      inputs: [{ materialId: "", items: 0 }],
      outputs: [{ materialId: material.id, items: 1 }], // Auto-set this material as output
      heatConsumptionP: null,
    });
    
    saveDb();
    renderMaterials(); // Re-render to show the new recipe
    setStatus("Recipe added.");
    
    // Expand the newly created recipe card
    setTimeout(() => {
      const card = $(`.recipeCard[data-recipe-id="${id}"]`);
      if (card) {
        card.classList.add("is-open");
        card.querySelector(".recipeCard__body")?.classList.remove("hidden");
      }
    }, 50);
  }
  
  function deleteRecipe(recipeId) {
    if (!recipeId) return;
    if (!confirm("Delete this recipe?")) return;
    
    state.db.recipes = state.db.recipes.filter((r) => r.id !== recipeId);
    saveDb();
    renderMaterials(); // Re-render to update the recipe list
    setStatus("Recipe deleted.");
  }

  function deleteSelected(kind) {
    const id = state.ui.selected[kind];
    if (!id) return;
    if (!confirm("Delete this item?")) return;

    if (kind === "materials") {
      // Also remove material references from recipes
      state.db.recipes = state.db.recipes.map((r) => ({
        ...r,
        inputs: r.inputs.filter((io) => io.materialId !== id),
        outputs: r.outputs.filter((io) => io.materialId !== id),
      }));
      state.db.materials = state.db.materials.filter((m) => m.id !== id);
      state.ui.selected.materials = null;
      saveDb();
      renderAll();
      setStatus("Material deleted.");
      return;
    }
    if (kind === "machines") {
      state.db.machines = state.db.machines.filter((m) => m.id !== id);
      // Unset machine references in recipes
      state.db.recipes = state.db.recipes.map((r) => (r.machineId === id ? { ...r, machineId: "" } : r));
      state.ui.selected.machines = null;
      saveDb();
      renderAll();
      setStatus("Machine deleted.");
      return;
    }
  }

  function onSaveMaterial(form, id) {
    const m = getMaterialById(id);
    if (!m) return;

    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return setStatus("Material name is required.", "error");

    const buyPrice = toNumberOrNull(fd.get("buyPrice"));
    const salePrice = toNumberOrNull(fd.get("salePrice"));
    const isFuel = fd.get("isFuel") === "on";
    const fuelValue = toNumberOrNull(fd.get("fuelValue"));
    const stackSize = toNumberOrNull(fd.get("stackSize"));
    const isFertilizer = fd.get("isFertilizer") === "on";
    const fertilizerNutrientValue = toNumberOrNull(fd.get("fertilizerNutrientValue"));
    const fertilizerMaxFertility = toNumberOrNull(fd.get("fertilizerMaxFertility"));
    const isPlant = fd.get("isPlant") === "on";
    const plantRequiredNutrient = toNumberOrNull(fd.get("plantRequiredNutrient"));

    // Ensure flags are mutually exclusive
    const selectedFlags = [isFuel, isFertilizer, isPlant].filter(Boolean);
    if (selectedFlags.length > 1) {
      return setStatus("Material can only be one type: Fuel, Fertilizer, or Plant.", "error");
    }

    m.name = name;
    m.buyPrice = buyPrice;
    m.salePrice = salePrice;
    m.isFuel = isFuel;
    m.fuelValue = isFuel ? fuelValue : null;
    m.isFertilizer = isFertilizer;
    m.fertilizerNutrientValue = isFertilizer ? fertilizerNutrientValue : null;
    m.fertilizerMaxFertility = isFertilizer ? fertilizerMaxFertility : null;
    m.isPlant = isPlant;
    m.plantRequiredNutrient = isPlant ? plantRequiredNutrient : null;
    m.stackSize = stackSize && stackSize > 0 ? Math.trunc(stackSize) : 1;

    saveDb();
    renderMaterials();
    setStatus("Material saved.", "ok");
  }

  function onSaveMachine(form, id) {
    const m = getMachineById(id);
    if (!m) return;

    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return setStatus("Machine name is required.", "error");

    const inputs = toIntOrNull(fd.get("inputs")) ?? 0;
    const outputs = toIntOrNull(fd.get("outputs")) ?? 0;
    const kindValue = fd.get("kind");
    let kind = "standard";
    if (kindValue === "heating_device") kind = "heating_device";
    else if (kindValue === "storage") kind = "storage";

    m.name = name;
    m.inputs = Math.max(0, inputs);
    m.outputs = Math.max(0, outputs);
    m.kind = kind;

    if (kind === "heating_device") {
      m.requiresFurnace = false;
      m.heatConsumptionP = null;
      m.storageSlots = null;
      m.footprintWidth = null;
      m.footprintLength = null;
      const base = toNumberOrNull(fd.get("baseHeatConsumptionP"));
      m.baseHeatConsumptionP = base == null ? 1 : Math.max(0, base);
      m.heatingAreaWidth = toIntOrNull(fd.get("heatingAreaWidth")) || 1;
      m.heatingAreaLength = toIntOrNull(fd.get("heatingAreaLength")) || 1;
    } else if (kind === "storage") {
      m.requiresFurnace = false;
      m.heatConsumptionP = null;
      m.baseHeatConsumptionP = 1;
      m.heatingAreaWidth = null;
      m.heatingAreaLength = null;
      m.footprintWidth = null;
      m.footprintLength = null;
      const slots = toIntOrNull(fd.get("storageSlots"));
      m.storageSlots = slots && slots > 0 ? slots : null;
      if (!m.storageSlots) return setStatus("Storage slots must be greater than 0.", "error");
    } else {
      // Standard
      m.baseHeatConsumptionP = 1;
      m.storageSlots = null;
      m.heatingAreaWidth = null;
      m.heatingAreaLength = null;
      m.requiresFurnace = fd.get("requiresFurnace") === "on";
      m.heatConsumptionP = m.requiresFurnace ? toNumberOrNull(fd.get("heatConsumptionP")) : null;
      m.footprintWidth = m.requiresFurnace ? (toIntOrNull(fd.get("footprintWidth")) || 1) : null;
      m.footprintLength = m.requiresFurnace ? (toIntOrNull(fd.get("footprintLength")) || 1) : null;
    }

    saveDb();
    renderMachines();
    renderMaterials(); // Update recipe displays in materials
    setStatus("Machine saved.", "ok");
  }

  function onSaveRecipe(form, id) {
    const r = getRecipeById(id);
    if (!r) return;

    const fd = new FormData(form);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) return setStatus("Recipe name is required.", "error");

    const machineId = String(fd.get("machineId") ?? "");
    if (!machineId) return setStatus("Recipe machine is required.", "error");
    if (!getMachineById(machineId)) return setStatus("Selected machine does not exist.", "error");

    const processingTimeSec = parseTimeString(fd.get("processingTimeSec"));
    if (processingTimeSec == null || processingTimeSec <= 0) return setStatus("Processing time must be > 0. Use format like '2m30s' or plain seconds.", "error");

    const inputs = readIoFromForm(fd, "inputs");
    const outputs = readIoFromForm(fd, "outputs");
    const heatConsumptionP = toNumberOrNull(fd.get("heatConsumptionP"));

    const machine = getMachineById(machineId);
    if (!machine) return setStatus("Selected machine does not exist.", "error");
    
    // Filter inputs to only those with a material selected
    const usedInputs = inputs.filter(inp => inp.materialId && inp.materialId.trim() !== "");
    
    // Validation: at least 1 input, up to machine's max inputs
    if (usedInputs.length === 0) return setStatus("Recipe must have at least 1 input with a material selected.", "error");
    if (usedInputs.length > machine.inputs) return setStatus(`Recipe cannot have more than ${machine.inputs} input(s) for this machine.`, "error");
    
    // Outputs must match exactly
    if (outputs.length !== machine.outputs) return setStatus(`Recipe must have exactly ${machine.outputs} output(s) to match the selected machine.`, "error");
    if (outputs.some((x) => !x.materialId)) return setStatus("All outputs must select a material.", "error");

    r.name = name;
    r.machineId = machineId;
    r.processingTimeSec = processingTimeSec;
    r.inputs = usedInputs; // Only save inputs with materials selected
    r.outputs = outputs;
    r.heatConsumptionP = heatConsumptionP;

    saveDb();
    renderMaterials(); // Re-render materials to show updated recipe
    setStatus("Recipe saved.", "ok");
  }

  function readIoFromForm(fd, kind) {
    // Extract keys like inputs[0].materialId, inputs[0].items ...
    const rows = [];
    for (const [k, v] of fd.entries()) {
      const m = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(k);
      if (!m) continue;
      const group = m[1];
      if (group !== kind) continue;
      const idx = Number(m[2]);
      const field = m[3];
      if (!Number.isFinite(idx)) continue;
      if (!rows[idx]) rows[idx] = { materialId: "", items: 0 };
      if (field === "materialId") rows[idx].materialId = String(v ?? "");
      if (field === "items") rows[idx].items = toNumberOrNull(v) ?? 0;
    }
    return rows.filter(Boolean);
  }

  // addRecipeIoRow and removeRecipeIoRow removed: inputs/outputs now auto-populated by selected machine

  function wireImportInput() {
    const input = $("#importFileInput");
    if (!input) return;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importDbFromFile(file);
      } catch (err) {
        console.error(err);
        setStatus("Failed to import JSON (invalid file).", "error");
      }
    });
  }

  // ---------- Boot ----------

  // ---------- Canvas / Build System ----------
  
  function wireCanvas() {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    let contextMenu = null;
    let rightClickStartPos = null; // Track right-click start position for context menu vs pan detection
    
    // Debounced save and sync for zoom
    let zoomSaveTimer = null;
    
    // Mouse wheel zoom
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      
      const zoomSensitivity = 0.001;
      const minZoom = 0.1;
      const maxZoom = 1.0;
      
      // Calculate new zoom level
      const delta = -e.deltaY;
      let newZoom = state.build.camera.zoom + (delta * zoomSensitivity);
      newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
      
      if (newZoom !== state.build.camera.zoom) {
        // Get mouse position in world coordinates before zoom
        const canvasRect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;
        const worldPosBefore = screenToWorld(mouseX, mouseY);
        
        // Apply zoom
        state.build.camera.zoom = newZoom;
        
        // Get mouse position in world coordinates after zoom
        const worldPosAfter = screenToWorld(mouseX, mouseY);
        
        // Adjust camera position to keep world position under mouse the same
        state.build.camera.x += worldPosBefore.x - worldPosAfter.x;
        state.build.camera.y += worldPosBefore.y - worldPosAfter.y;
        
        // Just update the transform, don't re-render
        updateCameraTransform();
        
        // Debounced save and sync (wait for zoom to finish)
        if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
        zoomSaveTimer = setTimeout(() => {
          syncRenderAfterCameraMove();
          saveBuild();
        }, 300);
      }
    }, { passive: false });
    
    // Right-click: track start for pan vs context menu
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) { // Right mouse button
        rightClickStartPos = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    });
    
    // Right-click context menu (only if no drag occurred)
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      
      // Check if this was a drag (moved more than 5 pixels)
      if (rightClickStartPos) {
        const dragDistance = Math.sqrt(
          Math.pow(e.clientX - rightClickStartPos.x, 2) +
          Math.pow(e.clientY - rightClickStartPos.y, 2)
        );
        
        if (dragDistance > 5) {
          // Was a drag, don't show context menu
          rightClickStartPos = null;
          return;
        }
      }
      
      rightClickStartPos = null;
      
      // Remove existing context menu
      if (contextMenu) contextMenu.remove();
      
      // Create context menu
      contextMenu = document.createElement("div");
      contextMenu.className = "contextMenu";
      contextMenu.style.left = `${e.clientX}px`;
      contextMenu.style.top = `${e.clientY}px`;
      contextMenu.innerHTML = `
        <button class="contextMenu__item" data-action="canvas:add-machine">
          <span>+ Add Machine</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-storage">
          <span>+ Add Storage</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-portal">
          <span>+ Add Purchasing Portal</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-fuel-source">
          <span>+ Add Fuel Source</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-nursery">
          <span>+ Add Nursery</span>
        </button>
        <button class="contextMenu__item" data-action="canvas:add-blueprint">
          <span>📐 Add Blueprint</span>
        </button>
      `;
      document.body.appendChild(contextMenu);
      
      // Store click position for machine placement (in world coordinates)
      const canvasRect = canvas.getBoundingClientRect();
      const screenX = e.clientX - canvasRect.left;
      const screenY = e.clientY - canvasRect.top;
      const worldPos = screenToWorld(screenX, screenY);
      contextMenu.dataset.x = String(worldPos.x);
      contextMenu.dataset.y = String(worldPos.y);
      
      // Close context menu on any click
      setTimeout(() => {
        const closeMenu = (evt) => {
          if (!contextMenu.contains(evt.target)) {
            contextMenu.remove();
            contextMenu = null;
            document.removeEventListener("click", closeMenu);
          }
        };
        document.addEventListener("click", closeMenu);
      }, 0);
    });
    
    // Handle context menu actions
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='canvas:add-machine']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addBlankMachineToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-storage']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          openStorageSelectionDialog(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-portal']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addPurchasingPortalToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-fuel-source']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addFuelSourceToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-nursery']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          addNurseryToCanvas(x, y);
          menu.remove();
        }
      }
      if (e.target.closest("[data-action='canvas:add-blueprint']")) {
        const menu = e.target.closest(".contextMenu");
        if (menu) {
          const x = parseFloat(menu.dataset.x);
          const y = parseFloat(menu.dataset.y);
          openBlueprintSelectionDialog(x, y);
          menu.remove();
        }
      }
    });
    
    // Blueprint drag and drop
    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const blueprintId = e.dataTransfer.getData("blueprintId");
      if (blueprintId) {
        // Calculate drop position in world coordinates
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const worldPos = screenToWorld(screenX, screenY);
        
        placeBlueprintOnCanvas(blueprintId, worldPos.x, worldPos.y);
      }
    });
    
    // Mouse down - start dragging or connection or panning or selection
    canvas.addEventListener("mousedown", (e) => {
      // Right button = pan camera
      if (e.button === 2) {
        state.ui.dragState = {
          type: "pan",
          startX: e.clientX,
          startY: e.clientY,
          startCamX: state.build.camera.x,
          startCamY: state.build.camera.y,
        };
        canvas.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      
      // Left button - check if starting a connection from output port
      const outputPort = e.target.closest("[data-output-port]");
      if (outputPort) {
        const machineEl = outputPort.closest("[data-placed-machine]");
        const machineId = machineEl.dataset.placedMachine;
        const portIdx = outputPort.dataset.outputPort; // Keep as string to support topper ports
        
        // Get world coordinates for the port
        const machineData = state.build.placedMachines.find(pm => pm.id === machineId);
        if (!machineData) return;
        
        const portRect = outputPort.getBoundingClientRect();
        const machineRect = machineEl.getBoundingClientRect();
        const { zoom } = state.build.camera;
        
        // Calculate port offset within machine card
        const portOffsetX = (portRect.left - machineRect.left + portRect.width) / zoom;
        const portOffsetY = (portRect.top - machineRect.top + portRect.height / 2) / zoom;
        
        // World coordinates
        const worldX = machineData.x + portOffsetX;
        const worldY = machineData.y + portOffsetY;
        
        state.ui.dragState = {
          type: "connection",
          fromMachineId: machineId,
          fromPortIdx: portIdx,
          startX: worldX,
          startY: worldY,
        };
        
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      
      // Ignore if clicking on other interactive elements
      if (e.target.closest("select, button, input, [data-input-port]")) {
        return;
      }
      
      const machineCard = e.target.closest("[data-placed-machine]");
      
      if (machineCard) {
        // Clicked on a machine card
        const machineId = machineCard.dataset.placedMachine;
        const pm = state.build.placedMachines.find(m => m.id === machineId);
        if (!pm) return;
        
        // Handle Ctrl+click for multi-selection
        if (e.ctrlKey || e.metaKey) {
          // Toggle selection
          if (state.build.selectedMachines.includes(machineId)) {
            state.build.selectedMachines = state.build.selectedMachines.filter(id => id !== machineId);
          } else {
            state.build.selectedMachines.push(machineId);
          }
          updateSelectionClasses();
          e.preventDefault();
          return;
        }
        
        // If clicking on an already selected machine, prepare for group drag
        const isAlreadySelected = state.build.selectedMachines.includes(machineId);
        
        // Store initial positions for all selected machines
        const initialPositions = new Map();
        if (isAlreadySelected && state.build.selectedMachines.length > 0) {
          // Group drag - store all selected machine positions
          state.build.selectedMachines.forEach(id => {
            const machine = state.build.placedMachines.find(m => m.id === id);
            if (machine) {
              initialPositions.set(id, { x: machine.x, y: machine.y });
            }
          });
        } else {
          // Single machine drag - select only this one
          state.build.selectedMachines = [machineId];
          initialPositions.set(machineId, { x: pm.x, y: pm.y });
          updateSelectionClasses();
        }
        
        state.ui.dragState = {
          type: "machine",
          machineIds: Array.from(state.build.selectedMachines), // All machines being dragged
          startX: e.clientX,
          startY: e.clientY,
          initialPositions: initialPositions,
          hasMoved: false,
        };
        
        e.preventDefault();
      } else {
        // Clicked on empty canvas - start drag-to-select
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const worldPos = screenToWorld(screenX, screenY);
        
        state.ui.dragState = {
          type: "select",
          startX: e.clientX,
          startY: e.clientY,
          startWorldX: worldPos.x,
          startWorldY: worldPos.y,
          currentX: e.clientX,
          currentY: e.clientY,
        };
        
        e.preventDefault();
      }
    });
    
    // Mouse move - drag machine, connection preview, selection box, or pan camera
    document.addEventListener("mousemove", (e) => {
      if (!state.ui.dragState) return;
      
      if (state.ui.dragState.type === "pan") {
        // Pan the camera
        const dx = e.clientX - state.ui.dragState.startX;
        const dy = e.clientY - state.ui.dragState.startY;
        
        const { zoom } = state.build.camera;
        
        // Move camera in opposite direction of mouse movement (drag world, not viewport)
        state.build.camera.x = state.ui.dragState.startCamX - (dx / zoom);
        state.build.camera.y = state.ui.dragState.startCamY - (dy / zoom);
        
        // Just update the transform, don't re-render everything
        updateCameraTransform();
        return;
      }
      
      if (state.ui.dragState.type === "connection") {
        // Convert mouse position to world coordinates for preview line
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = e.clientX - canvasRect.left;
        const screenY = e.clientY - canvasRect.top;
        const worldPos = screenToWorld(screenX, screenY);
        
        state.ui.dragState.currentX = worldPos.x;
        state.ui.dragState.currentY = worldPos.y;
        
        // Re-render connections only (for preview line)
        const svgEl = canvas.querySelector("#connectionsSvg");
        if (svgEl) {
          renderConnections(svgEl);
        }
        return;
      }
      
      if (state.ui.dragState.type === "select") {
        // Update selection box
        state.ui.dragState.currentX = e.clientX;
        state.ui.dragState.currentY = e.clientY;
        
        // Draw selection box
        drawSelectionBox();
        return;
      }
      
      if (state.ui.dragState.type === "machine") {
        const dx = e.clientX - state.ui.dragState.startX;
        const dy = e.clientY - state.ui.dragState.startY;
        
        // Consider it a drag if moved more than 3px
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          state.ui.dragState.hasMoved = true;
        }
        
        if (state.ui.dragState.hasMoved) {
          // Convert screen delta to world delta
          const { zoom } = state.build.camera;
          const worldDx = dx / zoom;
          const worldDy = dy / zoom;
          
          // Update all selected machines
          state.ui.dragState.machineIds.forEach(machineId => {
            const pm = state.build.placedMachines.find(m => m.id === machineId);
            const initialPos = state.ui.dragState.initialPositions.get(machineId);
            
            if (pm && initialPos) {
              // Update world position
              pm.x = initialPos.x + worldDx;
              pm.y = initialPos.y + worldDy;
              
              // Update machine element position directly (faster than full re-render)
              const machineEl = canvas.querySelector(`[data-placed-machine="${machineId}"]`);
              if (machineEl) {
                machineEl.style.left = `${pm.x}px`;
                machineEl.style.top = `${pm.y}px`;
              }
            }
          });
          
          // Re-render connections only (still need this for connection lines to follow)
          const svgEl = canvas.querySelector("#connectionsSvg");
          if (svgEl) {
            renderConnections(svgEl);
          }
        }
      }
    });
    
    // Mouse up - end dragging or complete connection or pan or selection
    document.addEventListener("mouseup", (e) => {
      if (!state.ui.dragState) return;
      
      if (state.ui.dragState.type === "pan") {
        // Sync render and save camera position after panning
        canvas.style.cursor = "";
        syncRenderAfterCameraMove();
        saveBuild();
        state.ui.dragState = null;
        return;
      }
      
      if (state.ui.dragState.type === "select") {
        // Complete selection box
        removeSelectionBox();
        
        // Calculate selection box in world coordinates
        const canvasRect = canvas.getBoundingClientRect();
        const startScreenX = state.ui.dragState.startX - canvasRect.left;
        const startScreenY = state.ui.dragState.startY - canvasRect.top;
        const endScreenX = e.clientX - canvasRect.left;
        const endScreenY = e.clientY - canvasRect.top;
        
        const startWorld = screenToWorld(startScreenX, startScreenY);
        const endWorld = screenToWorld(endScreenX, endScreenY);
        
        const minX = Math.min(startWorld.x, endWorld.x);
        const maxX = Math.max(startWorld.x, endWorld.x);
        const minY = Math.min(startWorld.y, endWorld.y);
        const maxY = Math.max(startWorld.y, endWorld.y);
        
        // Find all machines within selection box
        const selectedIds = [];
        state.build.placedMachines.forEach(pm => {
          const machineEl = document.querySelector(`[data-placed-machine="${pm.id}"]`);
          if (!machineEl) return;
          
          const width = machineEl.offsetWidth;
          const height = machineEl.offsetHeight;
          
          // Check if machine intersects with selection box
          const machineRight = pm.x + width;
          const machineBottom = pm.y + height;
          
          if (pm.x < maxX && machineRight > minX && pm.y < maxY && machineBottom > minY) {
            selectedIds.push(pm.id);
          }
        });
        
        state.build.selectedMachines = selectedIds;
        state.ui.dragState = null;
        updateSelectionClasses();
        
        if (selectedIds.length > 0) {
          setStatus(`Selected ${selectedIds.length} machine${selectedIds.length > 1 ? 's' : ''}.`);
        }
        
        // Set flag to prevent the subsequent click event from clearing selection
        state.ui.justCompletedSelection = true;
        setTimeout(() => {
          state.ui.justCompletedSelection = false;
        }, 0);
        
        return;
      }
      
      if (state.ui.dragState.type === "connection") {
        // Check if dropped on an input port
        const inputPort = e.target.closest("[data-input-port]");
        if (inputPort) {
          const machineEl = inputPort.closest("[data-placed-machine]");
          const toMachineId = machineEl.dataset.placedMachine;
          const toPortIdx = inputPort.dataset.inputPort; // Keep as string to support topper ports
          
          const { fromMachineId, fromPortIdx } = state.ui.dragState;
          
          // Check if connection already exists
          const existing = state.build.connections.find(
            conn => conn.fromMachineId === fromMachineId && 
                    conn.fromPortIdx === fromPortIdx && 
                    conn.toMachineId === toMachineId && 
                    conn.toPortIdx === toPortIdx
          );
          
          if (!existing) {
            state.build.connections.push({
              id: makeId("conn"),
              fromMachineId,
              fromPortIdx,
              toMachineId,
              toPortIdx,
            });
            
            // If connecting TO a storage machine, clear its manual inventories
            const toMachine = state.build.placedMachines.find(pm => pm.id === toMachineId);
            if (toMachine) {
              const machine = getMachineById(toMachine.machineId);
              if (machine && machine.kind === "storage" && toMachine.manualInventories) {
                toMachine.manualInventories = [];
              }
            }
            
            // Check if connecting to a heating device's fuel port - need full re-render
            let needsFullRender = false;
            if (toPortIdx === "fuel") {
              const toMachineDef = toMachine ? getMachineById(toMachine.machineId) : null;
              if (toMachineDef && toMachineDef.kind === "heating_device") {
                needsFullRender = true;
              }
            }
            
            saveBuild();
            setStatus("Connection created.");
            
            state.ui.dragState = null;
            renderCanvas(needsFullRender); // Force full re-render if connecting fuel
            return;
          }
        }
        
        state.ui.dragState = null;
        renderCanvas();
        return;
      }
      
      if (state.ui.dragState.type === "machine") {
        // If it was just a click (not a drag), selection already handled in mousedown
        if (state.ui.dragState.hasMoved) {
          // Save build after dragging
          saveBuild();
        }
        
        state.ui.dragState = null;
      }
    });
    
    // ESC key to cancel connection dragging or selection, Delete key to remove selected items
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (state.ui.dragState && state.ui.dragState.type === "connection") {
          state.ui.dragState = null;
          renderCanvas();
          setStatus("Connection cancelled.");
          return;
        }
        if (state.ui.dragState && state.ui.dragState.type === "select") {
          removeSelectionBox();
          state.ui.dragState = null;
          return;
        }
        // Escape also clears selection if nothing is being dragged
        if (state.build.selectedMachines.length > 0) {
          state.build.selectedMachines = [];
          updateSelectionClasses();
          return;
        }
      }
      
      // Delete key to remove selected machines or connection
      if (e.key === "Delete") {
        // Ignore if user is typing in an input field
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
          return;
        }
        
        if (state.build.selectedConnection) {
          deleteConnection(state.build.selectedConnection);
        } else if (state.build.selectedMachines.length > 0) {
          deleteSelectedMachines();
        }
      }
    });
    
    // Delegate events for buttons and ports
    canvas.addEventListener("click", (e) => {
      const cloneBtn = e.target.closest("[data-action='build:clone-machine']");
      if (cloneBtn) {
        const machineId = cloneBtn.closest("[data-placed-machine]").dataset.placedMachine;
        clonePlacedMachine(machineId);
        e.stopPropagation();
        return;
      }
      
      const deleteBtn = e.target.closest("[data-action='build:delete-machine']");
      if (deleteBtn) {
        const machineId = deleteBtn.closest("[data-placed-machine]").dataset.placedMachine;
        deletePlacedMachine(machineId);
        e.stopPropagation();
        return;
      }
      
      const addManualBtn = e.target.closest("[data-action='storage:add-manual']");
      if (addManualBtn) {
        const machineId = addManualBtn.closest("[data-placed-machine]").dataset.placedMachine;
        openManualStorageDialog(machineId);
        e.stopPropagation();
        return;
      }
      
      const removeManualBtn = e.target.closest("[data-action='storage:remove-manual']");
      if (removeManualBtn) {
        const machineId = removeManualBtn.closest("[data-placed-machine]").dataset.placedMachine;
        const idx = parseInt(removeManualBtn.dataset.manualIdx);
        removeManualStorageMaterial(machineId, idx);
        e.stopPropagation();
        return;
      }
      
      const changeTypeBtn = e.target.closest("[data-action='storage:change-type']");
      if (changeTypeBtn) {
        const machineId = changeTypeBtn.closest("[data-placed-machine]").dataset.placedMachine;
        openStorageTypeChangeDialog(machineId);
        e.stopPropagation();
        return;
      }
      
      const addTopperBtn = e.target.closest("[data-action='heating:add-topper']");
      if (addTopperBtn) {
        const machineId = addTopperBtn.closest("[data-placed-machine]").dataset.placedMachine;
        openAddTopperDialog(machineId);
        e.stopPropagation();
        return;
      }
      
      const removeTopperBtn = e.target.closest("[data-action='heating:remove-topper']");
      if (removeTopperBtn) {
        const machineId = removeTopperBtn.closest("[data-placed-machine]").dataset.placedMachine;
        const idx = parseInt(removeTopperBtn.dataset.topperIdx);
        removeTopper(machineId, idx);
        e.stopPropagation();
        return;
      }
      
      const editBlueprintBtn = e.target.closest("[data-action='blueprint:edit']");
      if (editBlueprintBtn) {
        const machineId = editBlueprintBtn.closest("[data-placed-machine]").dataset.placedMachine;
        enterBlueprintEditMode(machineId);
        e.stopPropagation();
        return;
      }
      
      // Check if clicked on a connection (polyline)
      if (e.target.tagName === "polyline" && e.target.dataset.connectionId) {
        selectConnection(e.target.dataset.connectionId);
        e.stopPropagation();
        return;
      }
      
      // If clicked on canvas background (not on a machine or connection), deselect
      // Skip if we just completed a drag-to-select operation
      if ((e.target === canvas || e.target.closest("#connectionsSvg")) && !state.ui.justCompletedSelection) {
        state.build.selectedMachines = [];
        state.build.selectedConnection = null;
        updateSelectionClasses();
      }
    });
    
    // Handle recipe/machine selection changes
    canvas.addEventListener("change", (e) => {
      const recipeSelect = e.target.closest("[data-machine-recipe-select]");
      if (recipeSelect) {
        const machineId = recipeSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const recipeId = recipeSelect.value;
        updatePlacedMachineRecipe(machineId, recipeId);
        return;
      }
      
      const machineSelect = e.target.closest("[data-machine-select]");
      if (machineSelect) {
        const placedMachineId = machineSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const machineId = machineSelect.value;
        if (machineId) {
          updatePlacedMachineType(placedMachineId, machineId);
        }
        return;
      }
      
      const countInput = e.target.closest("[data-machine-count]");
      if (countInput) {
        const placedMachineId = countInput.closest("[data-placed-machine]").dataset.placedMachine;
        const count = Math.max(1, Math.min(999, parseInt(countInput.value) || 1));
        updatePlacedMachineCount(placedMachineId, count);
        return;
      }
      
      const topperRecipeSelect = e.target.closest("[data-topper-recipe-select]");
      if (topperRecipeSelect) {
        const heatingDeviceId = topperRecipeSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const topperIdx = parseInt(topperRecipeSelect.dataset.topperIdx);
        const recipeId = topperRecipeSelect.value || null;
        updateTopperRecipe(heatingDeviceId, topperIdx, recipeId);
        return;
      }
      
      const portalMaterialSelect = e.target.closest("[data-portal-material-select]");
      if (portalMaterialSelect) {
        const placedMachineId = portalMaterialSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const materialId = portalMaterialSelect.value;
        updatePurchasingPortalMaterial(placedMachineId, materialId);
        return;
      }
      
      const fuelMaterialSelect = e.target.closest("[data-fuel-material-select]");
      if (fuelMaterialSelect) {
        const placedMachineId = fuelMaterialSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const fuelId = fuelMaterialSelect.value;
        updateFuelSourceMaterial(placedMachineId, fuelId);
        return;
      }
      
      const nurseryPlantSelect = e.target.closest("[data-nursery-plant-select]");
      if (nurseryPlantSelect) {
        const placedMachineId = nurseryPlantSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const plantId = nurseryPlantSelect.value;
        updateNurseryPlant(placedMachineId, plantId);
        return;
      }
      
      const nurseryFertilizerSelect = e.target.closest("[data-nursery-fertilizer-select]");
      if (nurseryFertilizerSelect) {
        const placedMachineId = nurseryFertilizerSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const fertilizerId = nurseryFertilizerSelect.value;
        updateNurseryFertilizer(placedMachineId, fertilizerId);
        return;
      }
      
      const heatingFuelSelect = e.target.closest("[data-heating-fuel-select]");
      if (heatingFuelSelect) {
        const placedMachineId = heatingFuelSelect.closest("[data-placed-machine]").dataset.placedMachine;
        const fuelId = heatingFuelSelect.value;
        updateHeatingDevicePreviewFuel(placedMachineId, fuelId);
        return;
      }
      
      const storageSlotsInput = e.target.closest("[data-storage-slots]");
      if (storageSlotsInput) {
        const placedMachineId = storageSlotsInput.closest("[data-placed-machine]").dataset.placedMachine;
        const slots = Math.max(1, parseInt(storageSlotsInput.value) || 1);
        updateStorageSlots(placedMachineId, slots);
        return;
      }
    });
  }
  
  function updatePlacedMachineCount(machineId, count) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;
    
    pm.count = count;
    saveBuild();
    renderCanvas(true); // Force recreate - count display changed
  }
  
  function updatePurchasingPortalMaterial(machineId, materialId) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "purchasing_portal") return;
    
    pm.materialId = materialId || null;
    saveBuild();
    renderCanvas(true); // Force recreate - material selection changed
  }
  
  function updateFuelSourceMaterial(machineId, fuelId) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "fuel_source") return;
    
    pm.fuelId = fuelId || null;
    saveBuild();
    renderCanvas(true); // Force recreate - fuel selection changed
  }
  
  function updateNurseryPlant(machineId, plantId) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "nursery") return;
    
    pm.plantId = plantId || null;
    saveBuild();
    renderCanvas(true); // Force recreate - plant selection changed
  }
  
  function updateNurseryFertilizer(machineId, fertilizerId) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm || pm.type !== "nursery") return;
    
    pm.fertilizerId = fertilizerId || null;
    saveBuild();
    renderCanvas(true); // Force recreate - fertilizer selection changed
  }
  
  function updateHeatingDevicePreviewFuel(machineId, fuelId) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;
    
    const machine = getMachineById(pm.machineId);
    if (!machine || machine.kind !== "heating_device") return;
    
    pm.previewFuelId = fuelId || null;
    saveBuild();
    renderCanvas(true); // Force recreate - fuel selection changed
  }
  
  function updateStorageSlots(machineId, slots) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;
    
    const machine = getMachineById(pm.machineId);
    if (!machine || machine.kind !== "storage") return;
    
    // Enforce max from definition
    pm.storageSlots = Math.min(slots, machine.storageSlots);
    saveBuild();
    renderCanvas(true); // Force recreate - storage slots changed
  }
  
  // ---------- Production Calculation ----------
  
  /**
   * Get material ID from a machine's port
   * @param {object} placedMachine - The placed machine
   * @param {number} portIdx - Port index
   * @param {string} type - "input" or "output"
   * @returns {string|null} Material ID or null
   */
  function getMaterialIdFromPort(placedMachine, portIdx, type) {
    // Blueprint type
    if (placedMachine.type === "blueprint") {
      const bpData = placedMachine.blueprintData || {};
      const portIdxNum = parseInt(portIdx);
      
      if (type === "input") {
        const input = bpData.inputs?.[portIdxNum];
        return input?.materialId || null;
      } else {
        const output = bpData.outputs?.[portIdxNum];
        return output?.materialId || null;
      }
    }
    
    // Purchasing portal
    if (placedMachine.type === "purchasing_portal") {
      return placedMachine.materialId;
    }
    
    if (placedMachine.type === "fuel_source") {
      return placedMachine.fuelId;
    }
    
    if (placedMachine.type === "nursery") {
      if (type === "output") {
        return placedMachine.plantId;
      } else {
        // Input port - determine fertilizer from connection or selection
        // First check if there's a connected source
        const incomingConnections = state.build.connections.filter(conn => conn.toMachineId === placedMachine.id);
        if (incomingConnections.length > 0) {
          const sourceConn = incomingConnections[0];
          const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
          if (sourceMachine) {
            const fertId = getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
            if (fertId) return fertId;
          }
        }
        // Otherwise use selected fertilizer
        return placedMachine.fertilizerId || null;
      }
    }
    
    // Check if this is a heating device with grouped ports (portIdx is a string like "grouped-input-materialId" or "grouped-output-materialId")
    const machine = getMachineById(placedMachine.machineId);
    if (machine && machine.kind === "heating_device" && typeof portIdx === 'string') {
      // Handle grouped ports
      if (portIdx.startsWith('grouped-input-') || portIdx.startsWith('grouped-output-')) {
        const materialId = portIdx.replace(/^grouped-(input|output)-/, '');
        return materialId || null;
      }
      
      // Handle individual topper ports (legacy, for backward compatibility)
      if (portIdx.startsWith('topper-')) {
        const match = portIdx.match(/^topper-(\d+)-(\d+)$/);
        if (match) {
          const topperIdx = parseInt(match[1]);
          const topperPortIdx = parseInt(match[2]);
          const topper = placedMachine.toppers?.[topperIdx];
          if (topper && topper.recipeId) {
            const topperRecipe = getRecipeById(topper.recipeId);
            if (topperRecipe) {
              if (type === "output") {
                return topperRecipe.outputs[topperPortIdx]?.materialId || null;
              } else {
                return topperRecipe.inputs[topperPortIdx]?.materialId || null;
              }
            }
          }
        }
        return null;
      }
    }
    
    // Storage machine - return material from inventories
    if (machine && machine.kind === "storage" && type === "output") {
      // Check manual inventories first
      const manualInventories = placedMachine.manualInventories || [];
      if (manualInventories.length > 0) {
        // Return the first material (storage can output any stored material)
        return manualInventories[0]?.materialId || null;
      }
      
      // Check incoming connections to determine what material is flowing through
      const incomingConnections = state.build.connections.filter(
        conn => conn.toMachineId === placedMachine.id
      );
      
      if (incomingConnections.length > 0) {
        // Get material from first input connection
        const sourceConn = incomingConnections[0];
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
        if (sourceMachine) {
          return getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
        }
      }
      
      return null;
    }
    
    // Regular machine with recipe
    const recipe = placedMachine.recipeId ? getRecipeById(placedMachine.recipeId) : null;
    if (!recipe) return null;
    
    if (type === "output") {
      return recipe.outputs[portIdx]?.materialId || null;
    } else {
      return recipe.inputs[portIdx]?.materialId || null;
    }
  }
  
  /**
   * Get output rate for a specific port on a machine
   * @param {object} placedMachine - The placed machine
   * @param {number} portIdx - Output port index
   * @returns {number} Rate (items/min)
   */
  function getPortOutputRate(placedMachine, portIdx) {
    // Blueprint type
    if (placedMachine.type === "blueprint") {
      const bpData = placedMachine.blueprintData || {};
      const portIdxNum = parseInt(portIdx);
      const output = bpData.outputs?.[portIdxNum];
      const count = placedMachine.count || 1;
      return (output?.rate || 0) * count;
    }
    
    const machine = getMachineById(placedMachine.machineId);
    if (!machine) {
      // Special types without machineId
      if (placedMachine.type === "purchasing_portal") {
        return getConveyorSpeed();
      }
      if (placedMachine.type === "fuel_source") {
        // Calculate fuel rate based on connected heating devices
        const fuel = placedMachine.fuelId ? getMaterialById(placedMachine.fuelId) : null;
        if (!fuel || !fuel.fuelValue) return 0;
        
        let totalConsumptionP = 0;
        const connections = state.build.connections.filter(conn => conn.fromMachineId === placedMachine.id);
        
        connections.forEach(conn => {
          const targetMachine = state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
          if (!targetMachine) return;
          
          const targetMachineDef = getMachineById(targetMachine.machineId);
          if (targetMachineDef && targetMachineDef.kind === "heating_device") {
            // Base consumption with skill modifier
            let heatP = getFuelConsumptionRate(targetMachineDef.baseHeatConsumptionP || 1);
            // Add topper consumption with skill modifier
            (targetMachine.toppers || []).forEach(topper => {
              const topperMachine = getMachineById(topper.machineId);
              if (topperMachine) {
                heatP += getFuelConsumptionRate(topperMachine.heatConsumptionP || 0);
              }
            });
            totalConsumptionP += heatP;
          }
        });
        
        if (totalConsumptionP === 0) return 0;
        const adjustedFuelValue = getFuelHeatValue(fuel.fuelValue);
        return (60 * totalConsumptionP) / adjustedFuelValue;
      }
      if (placedMachine.type === "storage") {
        // Storage: Each output port is independently capped at conveyor speed
        // This represents a single belt/port, not multiple belts
        return getConveyorSpeed();
      }
      if (placedMachine.type === "nursery") {
        // Calculate nursery output rate
        const plant = placedMachine.plantId ? getMaterialById(placedMachine.plantId) : null;
        if (!plant || !plant.plantRequiredNutrient) return 0;
        
        // Get fertilizer from connected input OR selected fertilizer
        let fertilizer = null;
        const incomingConnections = state.build.connections.filter(conn => conn.toMachineId === placedMachine.id);
        
        if (incomingConnections.length > 0) {
          const sourceConn = incomingConnections[0];
          const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
          if (sourceMachine) {
            const fertId = getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
            if (fertId) {
              fertilizer = getMaterialById(fertId);
            }
          }
        }
        
        // If no connection, use selected fertilizer
        if (!fertilizer && placedMachine.fertilizerId) {
          fertilizer = getMaterialById(placedMachine.fertilizerId);
        }
        
        if (!fertilizer || !fertilizer.isFertilizer || !fertilizer.fertilizerMaxFertility) return 0;
        
        const Nv = plant.plantRequiredNutrient;
        const Ff = fertilizer.fertilizerMaxFertility; // Max Fertility is NOT affected by skill
        
        // Plant Growth Time = Nv / Ff
        const growthTime = Nv / Ff;
        
        // Output Rate = 60 / growthTime (per nursery)
        const outputPerNursery = 60 / growthTime;
        
        // Multiply by nursery count
        const count = placedMachine.count || 1;
        return outputPerNursery * count;
      }
      return 0;
    }
    
    // Storage machine - calculate per-port rate
    if (machine.kind === "storage") {
      return calculateStoragePortOutputRate(placedMachine, portIdx);
    }
    
    // Heating device with grouped or individual topper outputs
    if (machine.kind === "heating_device" && typeof portIdx === 'string') {
      // Handle grouped output ports
      if (portIdx.startsWith('grouped-output-')) {
        const materialId = portIdx.replace(/^grouped-output-/, '');
        let totalRate = 0;
        
        // Sum outputs from all toppers that produce this material
        (placedMachine.toppers || []).forEach(topper => {
          if (!topper.recipeId) return;
          const topperRecipe = getRecipeById(topper.recipeId);
          if (!topperRecipe) return;
          
          const effectiveTime = getFactoryEfficiency(topperRecipe.processingTimeSec);
          topperRecipe.outputs.forEach(out => {
            if (out.materialId === materialId) {
              totalRate += (out.items / effectiveTime) * 60;
            }
          });
        });
        
        // Multiply by furnace count
        const count = placedMachine.count || 1;
        return totalRate * count;
      }
      
      // Handle individual topper ports (legacy, for backward compatibility)
      if (portIdx.startsWith('topper-')) {
        const match = portIdx.match(/^topper-(\d+)-(\d+)$/);
        if (match) {
          const topperIdx = parseInt(match[1]);
          const topperPortIdx = parseInt(match[2]);
          const topper = placedMachine.toppers?.[topperIdx];
          
          if (topper && topper.recipeId) {
            const topperRecipe = getRecipeById(topper.recipeId);
            if (topperRecipe && topperRecipe.outputs[topperPortIdx]) {
              const effectiveTime = getFactoryEfficiency(topperRecipe.processingTimeSec);
              const count = 1; // Each topper is always count 1
              return (topperRecipe.outputs[topperPortIdx].items / effectiveTime) * 60 * count;
            }
          }
        }
        return 0;
      }
    }
    
    // Regular machine with recipe
    if (placedMachine.recipeId) {
      const recipe = getRecipeById(placedMachine.recipeId);
      if (!recipe || !recipe.outputs[portIdx]) return 0;
      
      const effectiveTime = getFactoryEfficiency(recipe.processingTimeSec);
      const count = placedMachine.count || 1;
      return (recipe.outputs[portIdx].items / effectiveTime) * 60 * count;
    }
    
    return 0;
  }
  
  /**
   * Calculate input demand for a specific machine port
   * @param {object} placedMachine - The placed machine
   * @param {number} portIdx - Input port index
   * @returns {number} Demand rate (items/min)
   */
  function getPortInputDemand(placedMachine, portIdx) {
    // Blueprint type
    if (placedMachine.type === "blueprint") {
      const bpData = placedMachine.blueprintData || {};
      const portIdxNum = parseInt(portIdx);
      const input = bpData.inputs?.[portIdxNum];
      const count = placedMachine.count || 1;
      return (input?.rate || 0) * count;
    }
    
    const machine = getMachineById(placedMachine.machineId);
    if (!machine) {
      // Handle special types without machineId
      if (placedMachine.type === "nursery") {
        // Calculate nursery fertilizer input demand
        const plant = placedMachine.plantId ? getMaterialById(placedMachine.plantId) : null;
        if (!plant || !plant.plantRequiredNutrient) return 0;
        
        // Get fertilizer from connected input OR selected fertilizer
        let fertilizer = null;
        const incomingConnections = state.build.connections.filter(conn => conn.toMachineId === placedMachine.id);
        
        if (incomingConnections.length > 0) {
          const sourceConn = incomingConnections[0];
          const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
          if (sourceMachine) {
            const fertId = getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
            if (fertId) {
              fertilizer = getMaterialById(fertId);
            }
          }
        }
        
        // If no connection, use selected fertilizer
        if (!fertilizer && placedMachine.fertilizerId) {
          fertilizer = getMaterialById(placedMachine.fertilizerId);
        }
        
        if (!fertilizer || !fertilizer.isFertilizer || !fertilizer.fertilizerMaxFertility || !fertilizer.fertilizerNutrientValue) return 0;
        
        const Nv = plant.plantRequiredNutrient;
        const Ff = fertilizer.fertilizerMaxFertility; // Max Fertility is NOT affected by skill
        const Fv = getFertilizerValue(fertilizer.fertilizerNutrientValue); // Nutrient Value IS affected by skill
        
        // Fertilizer duration = Fv / Ff
        const fertilizerDuration = Fv / Ff;
        
        // Required Fertilizer p/m = 60 / fertilizerDuration (per nursery)
        const inputPerNursery = 60 / fertilizerDuration;
        
        // Multiply by nursery count
        const count = placedMachine.count || 1;
        return inputPerNursery * count;
      }
      return 0;
    }
    
    // Storage machines: Each input port can accept up to conveyor speed
    // This represents the belt capacity for this specific port
    if (machine.kind === "storage") {
      return getConveyorSpeed();
    }
    
    // Heating device fuel input
    if (machine.kind === "heating_device" && portIdx === "fuel") {
      // Calculate total heat consumption
      let totalHeatP = getFuelConsumptionRate(machine.baseHeatConsumptionP || 1);
      
      (placedMachine.toppers || []).forEach(topper => {
        const topperMachine = getMachineById(topper.machineId);
        if (topperMachine) {
          totalHeatP += getFuelConsumptionRate(topperMachine.heatConsumptionP || 0);
        }
      });
      
      // Multiply by furnace count
      const count = placedMachine.count || 1;
      totalHeatP *= count;
      
      // Get the fuel material from the incoming connection
      const fuelConnection = state.build.connections.find(
        conn => conn.toMachineId === placedMachine.id && conn.toPortIdx === "fuel"
      );
      
      if (fuelConnection) {
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === fuelConnection.fromMachineId);
        if (sourceMachine) {
          const fuelMaterialId = getMaterialIdFromPort(sourceMachine, fuelConnection.fromPortIdx, "output");
          const fuelMaterial = fuelMaterialId ? getMaterialById(fuelMaterialId) : null;
          
          if (fuelMaterial && fuelMaterial.fuelValue) {
            const adjustedFuelValue = getFuelHeatValue(fuelMaterial.fuelValue);
            return (60 * totalHeatP) / adjustedFuelValue;
          }
        }
      }
      
      return 0;
    }
    
    // Heating device with grouped input ports
    if (machine.kind === "heating_device" && typeof portIdx === 'string' && portIdx.startsWith('grouped-input-')) {
      const materialId = portIdx.replace(/^grouped-input-/, '');
      let totalDemand = 0;
      
      // Sum inputs from all toppers that require this material
      (placedMachine.toppers || []).forEach(topper => {
        if (!topper.recipeId) return;
        const topperRecipe = getRecipeById(topper.recipeId);
        if (!topperRecipe) return;
        
        const effectiveTime = getFactoryEfficiency(topperRecipe.processingTimeSec);
        topperRecipe.inputs.forEach(inp => {
          if (inp.materialId === materialId) {
            totalDemand += (inp.items / effectiveTime) * 60;
          }
        });
      });
      
      // Multiply by furnace count
      const count = placedMachine.count || 1;
      return totalDemand * count;
    }
    
    // Regular machines with recipes have fixed input demand
    if (placedMachine.recipeId) {
      const recipe = getRecipeById(placedMachine.recipeId);
      if (!recipe || !recipe.inputs[portIdx]) return 0;
      
      const effectiveTime = getFactoryEfficiency(recipe.processingTimeSec);
      const count = placedMachine.count || 1;
      return (recipe.inputs[portIdx].items / effectiveTime) * 60 * count;
    }
    
    return 0;
  }
  
  /**
   * Calculate output rate per port for a storage machine
   * @param {object} placedStorage - The placed storage machine
   * @returns {number} Rate per output port (items/min)
   */
  /**
   * Calculate output rate for a specific port on a storage machine
   * @param {object} placedStorage - The placed storage machine
   * @param {number} portIdx - The output port index
   * @returns {number} Output rate in items/min for this specific port
   */
  function calculateStoragePortOutputRate(placedStorage, portIdx) {
    const machine = getMachineById(placedStorage.machineId);
    if (!machine || machine.kind !== "storage") return 0;
    
    // Check if this specific port is connected
    const portConnection = state.build.connections.find(
      conn => conn.fromMachineId === placedStorage.id && conn.fromPortIdx === portIdx
    );
    
    // If this port isn't connected, return 0
    if (!portConnection) {
      return 0;
    }
    
    // Get the downstream machine and its demand
    const destMachine = state.build.placedMachines.find(
      pm => pm.id === portConnection.toMachineId
    );
    if (!destMachine) return 0;
    
    const demand = getPortInputDemand(destMachine, portConnection.toPortIdx);
    
    // Get all incoming connections to determine available input
    const incomingConnections = state.build.connections.filter(
      conn => conn.toMachineId === placedStorage.id
    );
    
    // If no inputs (manual mode), output at conveyor speed capped by demand
    if (incomingConnections.length === 0) {
      // Check if there are manual inventories
      const manualInventories = placedStorage.manualInventories || [];
      if (manualInventories.length > 0) {
        return Math.min(getConveyorSpeed(), demand);
      }
      return Math.min(getConveyorSpeed(), demand);
    }
    
    // If no inputs, output at conveyor speed (capped by demand)
    if (incomingConnections.length === 0) {
      return Math.min(getConveyorSpeed(), demand);
    }
    
    // Calculate total input rate
    let totalInputRate = 0;
    incomingConnections.forEach(conn => {
      const sourceMachine = state.build.placedMachines.find(
        pm => pm.id === conn.fromMachineId
      );
      if (!sourceMachine) return;
      
      // Get the rate from the source machine's output port
      const sourceRate = getPortOutputRate(sourceMachine, conn.fromPortIdx);
      totalInputRate += sourceRate;
    });
    
    // Get count of connected output ports
    const connectedOutputs = state.build.connections.filter(
      conn => conn.fromMachineId === placedStorage.id
    ).length;
    
    if (connectedOutputs === 0) return 0;
    
    // Available rate per connected port
    const availablePerPort = totalInputRate / connectedOutputs;
    
    // Output at the minimum of: available rate, demand, or conveyor speed
    return Math.min(availablePerPort, demand, getConveyorSpeed());
  }
  
  function calculateStorageOutputRate(placedStorage) {
    const machine = getMachineById(placedStorage.machineId);
    if (!machine || machine.kind !== "storage") return 0;
    
    // Get all outgoing connections to determine downstream demand
    const outgoingConnections = state.build.connections.filter(
      conn => conn.fromMachineId === placedStorage.id
    );
    
    // Calculate total downstream demand
    let totalDownstreamDemand = 0;
    outgoingConnections.forEach(conn => {
      const destMachine = state.build.placedMachines.find(
        pm => pm.id === conn.toMachineId
      );
      if (!destMachine) return;
      
      // Get the demand from the destination machine's input port
      const demand = getPortInputDemand(destMachine, conn.toPortIdx);
      totalDownstreamDemand += demand;
    });
    
    // Get all incoming connections to determine available input
    const incomingConnections = state.build.connections.filter(
      conn => conn.toMachineId === placedStorage.id
    );
    
    // If no inputs and no outputs, output at conveyor speed per port
    if (incomingConnections.length === 0 && outgoingConnections.length === 0) {
      return getConveyorSpeed();
    }
    
    // If no inputs but has outputs, output at conveyor speed (capped by demand)
    if (incomingConnections.length === 0) {
      const maxOutputRate = getConveyorSpeed() * machine.outputs;
      const actualOutputRate = Math.min(maxOutputRate, totalDownstreamDemand);
      // Ensure per-port rate doesn't exceed belt speed
      return Math.min(actualOutputRate / machine.outputs, getConveyorSpeed());
    }
    
    // Calculate total input rate
    let totalInputRate = 0;
    incomingConnections.forEach(conn => {
      const sourceMachine = state.build.placedMachines.find(
        pm => pm.id === conn.fromMachineId
      );
      if (!sourceMachine) return;
      
      // Get the rate from the source machine's output port
      const sourceRate = getPortOutputRate(sourceMachine, conn.fromPortIdx);
      totalInputRate += sourceRate;
    });
    
    // If there are downstream machines, cap output at their demand
    if (outgoingConnections.length > 0) {
      const availablePerPort = totalInputRate / machine.outputs;
      const demandPerPort = totalDownstreamDemand / machine.outputs;
      return Math.min(availablePerPort, demandPerPort, getConveyorSpeed());
    }
    
    // No downstream connections, distribute input evenly across outputs (capped at belt speed)
    return Math.min(totalInputRate / machine.outputs, getConveyorSpeed());
  }
  
  /**
   * Format minutes to readable time string
   * @param {number} minutes - Time in minutes
   * @returns {string} Formatted time (e.g., "2m 30s", "45s")
   */
  function formatTimeMinutes(minutes) {
    if (!minutes || !isFinite(minutes)) return "—";
    
    const totalSeconds = Math.round(minutes * 60);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    
    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  }
  
  /**
   * Calculate storage inventory state for a placed storage machine
   * @param {object} placedStorage - The placed storage machine
   * @returns {Array} Array of inventory items with fill time calculations
   */
  function calculateStorageInventory(placedStorage) {
    const machine = getMachineById(placedStorage.machineId);
    if (!machine || machine.kind !== "storage") return [];
    
    const maxSlots = placedStorage.storageSlots || machine.storageSlots;
    
    // Calculate input rates per material
    const incomingConnections = state.build.connections.filter(
      conn => conn.toMachineId === placedStorage.id
    );
    
    // If no inputs connected, return manual inventories (if any)
    if (incomingConnections.length === 0) {
      const manualInventories = placedStorage.manualInventories || [];
      
      // Get output connections to calculate drain rate
      const outgoingConnections = state.build.connections.filter(
        conn => conn.fromMachineId === placedStorage.id
      );
      
      // Build a map of material -> output rate
      const outputRates = new Map();
      outgoingConnections.forEach(conn => {
        const destMachine = state.build.placedMachines.find(
          pm => pm.id === conn.toMachineId
        );
        if (!destMachine) return;
        
        // Get the material flowing through this connection from storage's perspective
        const connectionMaterialId = getMaterialIdFromPort(placedStorage, conn.fromPortIdx, "output");
        if (!connectionMaterialId) return;
        
        // Get the rate this connection is demanding
        const rate = getPortInputDemand(destMachine, conn.toPortIdx);
        if (rate > 0) {
          outputRates.set(connectionMaterialId, (outputRates.get(connectionMaterialId) || 0) + rate);
        }
      });
      
      return manualInventories.map(inv => {
        const material = getMaterialById(inv.materialId);
        if (!material) return null;
        
        const capacity = inv.slotsAllocated * (material.stackSize || 1);
        const currentAmount = inv.currentAmount || 0;
        const outputRate = outputRates.get(inv.materialId) || 0;
        const netRate = -outputRate; // Negative because it's draining
        
        let timeToFillMinutes = null;
        let status = "Manual";
        let timeDisplay = "Manual";
        let storedDisplay = null;
        
        // If there's output and current amount, calculate time to empty
        if (outputRate > 0 && currentAmount > 0) {
          timeToFillMinutes = currentAmount / outputRate;
          status = "Draining";
          storedDisplay = `${currentAmount} items stored`;
          timeDisplay = `Empty in ${formatTimeMinutes(timeToFillMinutes)} @ ${outputRate.toFixed(2)}/min`;
        } else if (outputRate === 0 && currentAmount > 0) {
          // Has items but no output
          storedDisplay = `${currentAmount} items stored`;
          timeDisplay = null;
        } else if (outputRate > 0 && currentAmount === 0) {
          // Output connected but no items
          storedDisplay = null;
          timeDisplay = `Empty (out: ${outputRate.toFixed(2)}/min)`;
        }
        
        return {
          materialId: inv.materialId,
          materialName: material.name,
          currentAmount,
          capacity,
          slotsAllocated: inv.slotsAllocated,
          inputRate: 0,
          outputRate,
          netRate,
          timeToFillMinutes,
          status,
          timeDisplay,
          storedDisplay
        };
      }).filter(inv => inv !== null);
    }
    
    // Get all materials flowing through this storage
    const materialFlows = new Map(); // materialId -> { inputRate, outputRate }
    
    incomingConnections.forEach(conn => {
      const sourceMachine = state.build.placedMachines.find(
        pm => pm.id === conn.fromMachineId
      );
      if (!sourceMachine) return;
      
      // Determine material from source port
      const materialId = getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
      if (!materialId) return;
      
      // Use actual connection rate (accounts for split outputs)
      const rate = getConnectionRate(conn);
      
      if (!materialFlows.has(materialId)) {
        materialFlows.set(materialId, { inputRate: 0, outputRate: 0 });
      }
      materialFlows.get(materialId).inputRate += rate;
    });
    
    // Calculate output rates per material based on downstream demand
    const outgoingConnections = state.build.connections.filter(
      conn => conn.fromMachineId === placedStorage.id
    );
    
    // For each outgoing connection, determine which material it's consuming
    outgoingConnections.forEach(conn => {
      const destMachine = state.build.placedMachines.find(
        pm => pm.id === conn.toMachineId
      );
      if (!destMachine) return;
      
      const materialId = getMaterialIdFromPort(destMachine, conn.toPortIdx, "input");
      if (!materialId) return;
      
      // Use actual connection rate (accounts for storage port conveyor speed cap per port)
      // Each storage output port is independently capped at conveyor speed
      const rate = getConnectionRate(conn);
      
      if (!materialFlows.has(materialId)) {
        materialFlows.set(materialId, { inputRate: 0, outputRate: 0 });
      }
      materialFlows.get(materialId).outputRate += rate;
    });
    
    // Calculate inventory status for each material using time-based simulation
    const inventories = [];
    
    // Build material info array
    const materials = Array.from(materialFlows.entries()).map(([materialId, rates]) => {
      const material = getMaterialById(materialId);
      if (!material) return null;
      
      const netRate = rates.inputRate - rates.outputRate; // items/min
      const stackSize = material.stackSize || 1;
      
      return {
        materialId,
        materialName: material.name,
        stackSize,
        netRate,
        inputRate: rates.inputRate,
        outputRate: rates.outputRate,
        currentAmount: 0,
        slotsAllocated: 0
      };
    }).filter(m => m !== null);
    
    if (materials.length === 0) {
      return inventories;
    }
    
    // Simulate slot allocation over time
    // Start by giving each material with positive net rate 1 slot
    let slotsRemaining = maxSlots;
    const accumulatingMaterials = materials.filter(m => m.netRate > 0);
    
    if (accumulatingMaterials.length === 0) {
      // No materials are accumulating, distribute slots evenly
      materials.forEach(m => {
        if (slotsRemaining > 0) {
          m.slotsAllocated = 1;
          slotsRemaining--;
        }
      });
    } else {
      // Give accumulating materials 1 slot each to start
      accumulatingMaterials.forEach(m => {
        if (slotsRemaining > 0) {
          m.slotsAllocated = 1;
          slotsRemaining--;
        }
      });
    }
    
    // Simulate time progression to allocate remaining slots
    // We simulate by calculating which material will fill first, then allocate accordingly
    while (slotsRemaining > 0 && accumulatingMaterials.length > 0) {
      // Calculate time to fill current capacity for each accumulating material
      const fillTimes = accumulatingMaterials.map(m => {
        if (m.slotsAllocated === 0 || m.netRate <= 0) {
          return { material: m, timeToFill: Infinity };
        }
        const capacity = m.slotsAllocated * m.stackSize;
        const remaining = capacity - m.currentAmount;
        const timeToFill = remaining / m.netRate;
        return { material: m, timeToFill };
      });
      
      // Find which material fills first
      fillTimes.sort((a, b) => a.timeToFill - b.timeToFill);
      const nextToFill = fillTimes[0];
      
      if (!isFinite(nextToFill.timeToFill)) {
        // No materials can fill, allocate remaining slots by net rate
        accumulatingMaterials.sort((a, b) => b.netRate - a.netRate);
        for (const m of accumulatingMaterials) {
          if (slotsRemaining > 0) {
            m.slotsAllocated++;
            slotsRemaining--;
          }
        }
        break;
      }
      
      // Advance time for all materials
      for (const m of accumulatingMaterials) {
        if (m.slotsAllocated > 0 && m.netRate > 0) {
          m.currentAmount += m.netRate * nextToFill.timeToFill;
        }
      }
      
      // The material that filled gets another slot
      const m = nextToFill.material;
      m.slotsAllocated++;
      slotsRemaining--;
      
      // If this was the last slot, we're done
      if (slotsRemaining === 0) {
        break;
      }
    }
    
    // If there are still slots remaining, distribute them
    if (slotsRemaining > 0) {
      const materialsWithSlots = materials.filter(m => m.slotsAllocated > 0);
      materialsWithSlots.forEach(m => {
        if (slotsRemaining > 0) {
          const toAdd = Math.min(slotsRemaining, Math.ceil(slotsRemaining / materialsWithSlots.length));
          m.slotsAllocated += toAdd;
          slotsRemaining -= toAdd;
        }
      });
    }
    
    // Now build the inventory results with proper fill time calculations
    materials.forEach(m => {
      // Only include materials that have slots allocated
      if (m.slotsAllocated === 0) return;
      
      const capacity = m.slotsAllocated * m.stackSize;
      
      // Reset current amount to 0 for fresh calculation (we're predicting, not tracking live state)
      const currentAmount = 0;
      
      // Calculate time to fill (if net positive) or time to empty (if net negative)
      let timeToFillMinutes = null;
      let status = "Stable";
      let timeDisplay = "—";
      
      if (m.netRate > 0) {
        // Filling
        const remaining = capacity - currentAmount;
        timeToFillMinutes = remaining / m.netRate;
        status = "Filling";
        timeDisplay = `Full in ${formatTimeMinutes(timeToFillMinutes)} @ ${m.inputRate.toFixed(2)}/min`;
      } else if (m.netRate < 0) {
        // Emptying (shouldn't happen with proper upstream, but handle it)
        status = "Emptying";
        timeDisplay = `Emptying @ ${Math.abs(m.outputRate).toFixed(2)}/min`;
      } else {
        // Balanced (input = output, will never fill)
        status = "Balanced";
        timeDisplay = `Balanced @ ${m.inputRate.toFixed(2)}/min`;
      }
      
      inventories.push({
        materialId: m.materialId,
        materialName: m.materialName,
        currentAmount,
        capacity,
        slotsAllocated: m.slotsAllocated,
        inputRate: m.inputRate,
        outputRate: m.outputRate,
        netRate: m.netRate,
        timeToFillMinutes,
        status,
        timeDisplay
      });
    });
    
    return inventories;
  }
  
  function calculateProductionFlow(selectedMachineIds = null) {
    // Build a map of production rates for each placed machine
    // If selectedMachineIds is provided, only calculate for those machines (for blueprint analysis)
    const productionRates = new Map(); // machineId -> { inputs: [{materialId, rate}], outputs: [{materialId, rate}] }
    
    const machinesToAnalyze = selectedMachineIds 
      ? state.build.placedMachines.filter(pm => selectedMachineIds.includes(pm.id))
      : state.build.placedMachines;
    
    machinesToAnalyze.forEach(pm => {
      if (pm.type === "purchasing_portal") {
        // Purchasing Portal outputs at max belt speed, assumes infinite coins
        const conveyorSpeed = getConveyorSpeed();
        productionRates.set(pm.id, {
          inputs: [], // No inputs (coins assumed infinite)
          outputs: [
            { portIdx: 0, materialId: pm.materialId, rate: conveyorSpeed },
          ],
        });
      } else if (pm.type === "fuel_source") {
        // Fuel Source outputs fuel at calculated rate based on connected heating devices
        const fuelRate = getPortOutputRate(pm, 0);
        productionRates.set(pm.id, {
          inputs: [], // No inputs (fuel source is infinite)
          outputs: [
            { portIdx: 0, materialId: pm.fuelId, rate: fuelRate },
          ],
        });
      } else if (pm.type === "nursery") {
        // Nursery outputs plants and requires fertilizer
        const plantRate = getPortOutputRate(pm, 0);
        const fertilizerRate = getPortInputDemand(pm, 0);
        
        // Get fertilizer material ID from connection or selection
        let fertilizerMaterialId = null;
        const incomingConn = state.build.connections.find(conn => conn.toMachineId === pm.id);
        if (incomingConn) {
          const sourceMachine = state.build.placedMachines.find(m => m.id === incomingConn.fromMachineId);
          if (sourceMachine) {
            fertilizerMaterialId = getMaterialIdFromPort(sourceMachine, incomingConn.fromPortIdx, "output");
          }
        }
        // If no connection, use selected fertilizer
        if (!fertilizerMaterialId) {
          fertilizerMaterialId = pm.fertilizerId;
        }
        
        const inputs = [];
        if (fertilizerMaterialId && fertilizerRate > 0) {
          inputs.push({ portIdx: 0, materialId: fertilizerMaterialId, rate: fertilizerRate });
        }
        
        productionRates.set(pm.id, {
          inputs,
          outputs: [
            { portIdx: 0, materialId: pm.plantId, rate: plantRate },
          ],
        });
      } else if (pm.type === "blueprint") {
        // Blueprint is a black box with defined inputs and outputs
        const bpData = pm.blueprintData || {};
        const count = pm.count || 1;
        const inputs = (bpData.inputs || []).map((inp, idx) => ({
          portIdx: idx,
          materialId: inp.materialId,
          rate: inp.rate * count
        }));
        const outputs = (bpData.outputs || []).map((out, idx) => ({
          portIdx: idx,
          materialId: out.materialId,
          rate: out.rate * count
        }));
        
        productionRates.set(pm.id, {
          inputs,
          outputs
        });
      } else if (pm.type === "machine" && pm.machineId) {
        const machine = getMachineById(pm.machineId);
        if (machine && machine.kind === "storage") {
          // Storage machines are pass-through - they don't produce or consume
          // So we don't add them to production rates at all
          // This prevents them from affecting net production calculations
          productionRates.set(pm.id, {
            inputs: [],
            outputs: []
          });
        } else if (machine && machine.kind === "heating_device") {
          // Heating device with toppers
          const count = pm.count || 1;
          const inputs = [];
          const outputs = [];
          
          // Add fuel as input (if connected)
          const fuelDemand = getPortInputDemand(pm, "fuel");
          if (fuelDemand > 0) {
            // Get fuel material from connection
            const fuelConn = state.build.connections.find(
              conn => conn.toMachineId === pm.id && conn.toPortIdx === "fuel"
            );
            if (fuelConn) {
              const sourceMachine = state.build.placedMachines.find(m => m.id === fuelConn.fromMachineId);
              if (sourceMachine) {
                const fuelMaterialId = getMaterialIdFromPort(sourceMachine, fuelConn.fromPortIdx, "output");
                if (fuelMaterialId) {
                  inputs.push({
                    portIdx: "fuel",
                    materialId: fuelMaterialId,
                    rate: fuelDemand
                  });
                }
              }
            }
          }
          
          // Collect inputs and outputs from all toppers
          (pm.toppers || []).forEach((topper, topperIdx) => {
            const topperRecipe = topper.recipeId ? getRecipeById(topper.recipeId) : null;
            if (!topperRecipe) return;
            
            const effectiveTime = getEffectiveProcessingTime(topperRecipe.processingTimeSec);
            
            topperRecipe.inputs.forEach((inp, inpIdx) => {
              if (inp.materialId) {
                inputs.push({
                  portIdx: `grouped-input-${inp.materialId}`,
                  materialId: inp.materialId,
                  rate: (inp.items / effectiveTime) * 60 * count
                });
              }
            });
            
            topperRecipe.outputs.forEach((out, outIdx) => {
              if (out.materialId) {
                outputs.push({
                  portIdx: `grouped-output-${out.materialId}`,
                  materialId: out.materialId,
                  rate: (out.items / effectiveTime) * 60 * count
                });
              }
            });
          });
          
          productionRates.set(pm.id, { inputs, outputs });
        } else if (pm.recipeId) {
          // Regular machine with recipe
          const recipe = getRecipeById(pm.recipeId);
          if (recipe) {
            const effectiveTime = getEffectiveProcessingTime(recipe.processingTimeSec);
            const count = pm.count || 1;
            
            productionRates.set(pm.id, {
              inputs: recipe.inputs.map((inp, idx) => ({
                portIdx: idx,
                materialId: inp.materialId,
                rate: (inp.items / effectiveTime) * 60 * count,
              })),
              outputs: recipe.outputs.map((out, idx) => ({
                portIdx: idx,
                materialId: out.materialId,
                rate: (out.items / effectiveTime) * 60 * count,
              })),
            });
          }
        }
      }
    });
    
    return productionRates;
  }
  
  function findSourceMachines() {
    // Find all machines with no input connections (starting points)
    const machinesWithInputs = new Set();
    state.build.connections.forEach(conn => {
      machinesWithInputs.add(conn.toMachineId);
    });
    
    return state.build.placedMachines.filter(pm => !machinesWithInputs.has(pm.id));
  }
  
  function findSinkMachines() {
    // Find all machines with no output connections (end points)
    const machinesWithOutputs = new Set();
    state.build.connections.forEach(conn => {
      machinesWithOutputs.add(conn.fromMachineId);
    });
    
    return state.build.placedMachines.filter(pm => !machinesWithOutputs.has(pm.id));
  }
  
  /**
   * Calculate machine efficiencies with backpressure system
   * Machines underclock based on actual downstream demand vs theoretical max output
   * This cascades upstream, reducing input requirements proportionally
   * Results are cached on connections and machine efficiency stored on placedMachine objects
   */
  function calculateMachineEfficiencies() {
    // Reset all machine efficiencies to 100% initially
    state.build.placedMachines.forEach(pm => {
      pm.efficiency = 1.0; // 100%
      pm.actualInputRates = {}; // materialId -> actual rate needed
      pm.actualOutputRates = {}; // materialId -> actual rate produced
    });
    
    // Build adjacency maps for traversal
    const outputConnections = new Map(); // fromMachineId -> [connections]
    const inputConnections = new Map(); // toMachineId -> [connections]
    
    state.build.connections.forEach(conn => {
      if (!outputConnections.has(conn.fromMachineId)) {
        outputConnections.set(conn.fromMachineId, []);
      }
      outputConnections.get(conn.fromMachineId).push(conn);
      
      if (!inputConnections.has(conn.toMachineId)) {
        inputConnections.set(conn.toMachineId, []);
      }
      inputConnections.get(conn.toMachineId).push(conn);
    });
    
    // Track which machines have been processed
    const processed = new Set();
    const processing = new Set(); // For cycle detection
    
    /**
     * Calculate efficiency for a machine recursively
     * @param {string} machineId - Machine to calculate efficiency for
     * @returns {number} Efficiency (0-1)
     */
    function calculateMachineEfficiency(machineId) {
      if (processed.has(machineId)) {
        const pm = state.build.placedMachines.find(m => m.id === machineId);
        return pm ? pm.efficiency : 1.0;
      }
      
      // Detect cycles
      if (processing.has(machineId)) {
        return 1.0; // Assume full efficiency for cycles
      }
      
      processing.add(machineId);
      
      const pm = state.build.placedMachines.find(m => m.id === machineId);
      if (!pm) {
        processed.add(machineId);
        processing.delete(machineId);
        return 1.0;
      }
      
      // Special cases that always run at 100%
      if (pm.type === "purchasing_portal" || pm.type === "fuel_source") {
        pm.efficiency = 1.0;
        processed.add(machineId);
        processing.delete(machineId);
        return 1.0;
      }
      
      // Storage machines are pass-through, always 100%
      const machine = pm.machineId ? getMachineById(pm.machineId) : null;
      if (machine && machine.kind === "storage") {
        pm.efficiency = 1.0;
        processed.add(machineId);
        processing.delete(machineId);
        return 1.0;
      }
      
      // Calculate max theoretical output for each material
      const maxOutputRates = new Map(); // materialId -> max rate
      
      // Get max output rates based on machine type
      if (pm.type === "machine" && pm.recipeId) {
        const recipe = getRecipeById(pm.recipeId);
        if (recipe) {
          const effectiveTime = getEffectiveProcessingTime(recipe.processingTimeSec);
          const count = pm.count || 1;
          recipe.outputs.forEach(out => {
            if (out.materialId) {
              const rate = (out.items / effectiveTime) * 60 * count;
              maxOutputRates.set(out.materialId, (maxOutputRates.get(out.materialId) || 0) + rate);
            }
          });
        }
      } else if (pm.type === "nursery") {
        const rate = getPortOutputRate(pm, 0);
        if (pm.plantId) {
          maxOutputRates.set(pm.plantId, rate);
        }
      } else if (pm.type === "blueprint") {
        const bpData = pm.blueprintData || {};
        const count = pm.count || 1;
        (bpData.outputs || []).forEach(out => {
          if (out.materialId) {
            maxOutputRates.set(out.materialId, out.rate * count);
          }
        });
      } else if (machine && machine.kind === "heating_device") {
        const count = pm.count || 1;
        (pm.toppers || []).forEach(topper => {
          const topperRecipe = topper.recipeId ? getRecipeById(topper.recipeId) : null;
          if (topperRecipe) {
            const effectiveTime = getEffectiveProcessingTime(topperRecipe.processingTimeSec);
            topperRecipe.outputs.forEach(out => {
              if (out.materialId) {
                const rate = (out.items / effectiveTime) * 60 * count;
                maxOutputRates.set(out.materialId, (maxOutputRates.get(out.materialId) || 0) + rate);
              }
            });
          }
        });
      }
      
      // Calculate actual demand from downstream machines using distribution algorithm
      const actualDemand = new Map(); // materialId -> total actual demand
      const outgoingConns = outputConnections.get(machineId) || [];
      
      // Group connections by output port
      const portGroups = new Map(); // portIdx -> [connections]
      outgoingConns.forEach(conn => {
        const portKey = String(conn.fromPortIdx);
        if (!portGroups.has(portKey)) {
          portGroups.set(portKey, []);
        }
        portGroups.get(portKey).push(conn);
      });
      
      // For each output port, calculate distributed rates
      portGroups.forEach((connections, portIdx) => {
        // First calculate downstream efficiencies for all targets
        connections.forEach(conn => {
          calculateMachineEfficiency(conn.toMachineId);
        });
        
        // Get max output for this port
        const maxOutput = getPortOutputRate(pm, portIdx);
        
        // Get material for this port
        const materialId = getMaterialIdFromPort(pm, portIdx, "output");
        if (!materialId) return;
        
        // Distribute the output among all connections from this port
        const distribution = distributeOutputRate(pm, portIdx, maxOutput);
        
        // Sum up actual distributed rates for this material
        let totalDistributed = 0;
        distribution.forEach(rate => {
          totalDistributed += rate;
        });
        
        actualDemand.set(materialId, (actualDemand.get(materialId) || 0) + totalDistributed);
      });
      
      // Calculate efficiency based on bottleneck (most constrained output)
      let efficiency = 1.0;
      
      if (maxOutputRates.size > 0) {
        // For each output material, check if demand is less than max output
        maxOutputRates.forEach((maxRate, materialId) => {
          const demand = actualDemand.get(materialId) || 0;
          
          if (maxRate > 0) {
            const materialEfficiency = demand / maxRate;
            // Use the minimum efficiency across all outputs (bottleneck)
            efficiency = Math.min(efficiency, materialEfficiency);
          }
        });
        
        // Clamp efficiency to [0, 1]
        efficiency = Math.max(0, Math.min(1, efficiency));
      }
      
      pm.efficiency = efficiency;
      processed.add(machineId);
      processing.delete(machineId);
      
      return efficiency;
    }
    
    // Start from all machines and calculate efficiencies
    state.build.placedMachines.forEach(pm => {
      calculateMachineEfficiency(pm.id);
    });
    
    // Update connection actual rates based on calculated efficiencies
    // Group connections by source machine and port
    const sourcePortMap = new Map(); // `${machineId}-${portIdx}` -> [connections]
    
    state.build.connections.forEach(conn => {
      const key = `${conn.fromMachineId}-${conn.fromPortIdx}`;
      if (!sourcePortMap.has(key)) {
        sourcePortMap.set(key, []);
      }
      sourcePortMap.get(key).push(conn);
    });
    
    // Calculate distribution for each source port
    sourcePortMap.forEach((connections, key) => {
      const firstConn = connections[0];
      const sourceMachine = state.build.placedMachines.find(pm => pm.id === firstConn.fromMachineId);
      
      if (!sourceMachine) return;
      
      const sourceEfficiency = sourceMachine.efficiency || 1.0;
      const maxRate = getPortOutputRate(sourceMachine, firstConn.fromPortIdx);
      const totalAvailable = maxRate * sourceEfficiency;
      
      // Use distribution algorithm
      const distribution = distributeOutputRate(sourceMachine, firstConn.fromPortIdx, totalAvailable);
      
      // Apply distributed rates to connections
      connections.forEach(conn => {
        conn.actualRate = distribution.get(conn.id) || 0;
        conn.lastCalculated = Date.now();
      });
    });
  }
  
  function getNetProduction(selectedMachineIds = null) {
    // Calculate the net production/consumption across the entire factory
    // If selectedMachineIds provided, it's only used to filter machines in calculateProductionFlow
    const productionRates = calculateProductionFlow(selectedMachineIds);
    const netMaterials = new Map(); // materialId -> net rate (positive = surplus, negative = deficit)
    
    const machinesToCalculate = selectedMachineIds 
      ? state.build.placedMachines.filter(pm => selectedMachineIds.includes(pm.id))
      : state.build.placedMachines;
    
    machinesToCalculate.forEach(pm => {
      const rates = productionRates.get(pm.id);
      if (!rates) return;
      
      // Count inputs as consumption
      rates.inputs.forEach(inp => {
        if (inp.materialId) {
          const current = netMaterials.get(inp.materialId) || 0;
          netMaterials.set(inp.materialId, current - inp.rate);
        }
      });
      
      // Count outputs as production
      // For infinite source machines (purchasing_portal, fuel_source), only count what's actually consumed
      const isInfiniteSource = pm.type === "purchasing_portal" || pm.type === "fuel_source";
      
      rates.outputs.forEach(out => {
        if (!out.materialId) return;
        
        let outputRate = out.rate;
        
        if (isInfiniteSource) {
          // For infinite sources, only count what's actually flowing through connections
          const outgoingConnections = state.build.connections.filter(conn => 
            conn.fromMachineId === pm.id
          );
          
          let actualFlow = 0;
          outgoingConnections.forEach(conn => {
            actualFlow += getConnectionRate(conn);
          });
          
          // Use the actual flow instead of theoretical capacity
          outputRate = actualFlow;
        }
        
        if (outputRate > 0) {
          const current = netMaterials.get(out.materialId) || 0;
          netMaterials.set(out.materialId, current + outputRate);
        }
      });
    });
    
    return netMaterials;
  }
  
  /**
   * Get total incoming rate of a specific material to a machine
   * @param {object} placedMachine - The placed machine
   * @param {string} materialId - The material ID to check
   * @returns {number} Total incoming rate in items/min
   */
  function getTotalIncomingRate(placedMachine, materialId) {
    const incomingConnections = state.build.connections.filter(
      conn => conn.toMachineId === placedMachine.id
    );
    
    let totalRate = 0;
    
    for (const connection of incomingConnections) {
      const sourceMachine = state.build.placedMachines.find(
        pm => pm.id === connection.fromMachineId
      );
      if (!sourceMachine) continue;
      
      const connMaterialId = getMaterialIdFromPort(sourceMachine, connection.fromPortIdx, "output");
      if (connMaterialId === materialId) {
        totalRate += getConnectionRate(connection);
      }
    }
    
    return totalRate;
  }
  
  /**
   * Get required rate of a specific material for a machine
   * @param {object} placedMachine - The placed machine
   * @param {string} materialId - The material ID to check
   * @returns {number} Required rate in items/min
   */
  function getRequiredMaterialRate(placedMachine, materialId) {
    if (placedMachine.type !== "machine" || !placedMachine.recipeId) {
      return 0;
    }
    
    const recipe = getRecipeById(placedMachine.recipeId);
    if (!recipe) return 0;
    
    const effectiveTime = getFactoryEfficiency(recipe.processingTimeSec);
    const count = placedMachine.count || 1;
    
    let totalRequired = 0;
    for (const inputSpec of recipe.inputs) {
      if (inputSpec && inputSpec.materialId === materialId) {
        totalRequired += (inputSpec.items / effectiveTime) * 60 * count;
      }
    }
    
    return totalRequired;
  }
  
  /**
   * Check if a machine has insufficient inputs (upstream can't meet demand or belt speed limitation)
   * @param {object} placedMachine - The placed machine to check
   * @returns {boolean} True if inputs are insufficient
   */
  function checkInsufficientInputs(placedMachine) {
    // Special types that don't have required inputs (only capacity/buffer limits)
    if (placedMachine.type === "storage") return false;
    if (placedMachine.type === "purchasing_portal") return false;
    if (placedMachine.type === "fuel_source") return false;
    if (placedMachine.type === "nursery") return false;
    if (placedMachine.type === "blueprint") return false;
    
    // Only check machines with recipes
    if (placedMachine.type !== "machine" || !placedMachine.recipeId) {
      return false;
    }
    
    const machine = getMachineById(placedMachine.machineId);
    const recipe = getRecipeById(placedMachine.recipeId);
    if (!machine || !recipe) return false;
    
    // Storage machines don't have required inputs (just capacity limits)
    if (machine.kind === "storage") return false;
    
    // Heating devices have special handling - they don't require inputs for toppers
    // (toppers are optional additions), only check if they have recipes selected
    if (machine.kind === "heating_device") return false;
    
    // Get all incoming connections
    const incomingConnections = state.build.connections.filter(
      conn => conn.toMachineId === placedMachine.id
    );
    
    // At least one input must be connected for recipes that require inputs
    if (incomingConnections.length === 0 && recipe.inputs && recipe.inputs.length > 0) {
      const hasRequiredInput = recipe.inputs.some(inp => inp && inp.materialId);
      if (hasRequiredInput) {
        return true;
      }
    }
    
    // Check each material required by the recipe
    for (const inputSpec of recipe.inputs) {
      if (!inputSpec || !inputSpec.materialId) continue;
      
      const requiredRate = getRequiredMaterialRate(placedMachine, inputSpec.materialId);
      const availableRate = getTotalIncomingRate(placedMachine, inputSpec.materialId);
      
      // Check if available rate is less than required (with small tolerance)
      if (availableRate < requiredRate - 0.01) {
        return true; // Insufficient
      }
    }
    
    return false;
  }

  /**
   * Convert world coordinates to screen coordinates
   * @param {number} worldX - X coordinate in world space
   * @param {number} worldY - Y coordinate in world space
   * @returns {{ x: number, y: number }} Screen coordinates
   */
  function worldToScreen(worldX, worldY) {
    const canvas = $("#designCanvas");
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const { x: camX, y: camY, zoom } = state.build.camera;
    
    // Calculate offset from camera position
    const offsetX = worldX - camX;
    const offsetY = worldY - camY;
    
    // Apply zoom and center on viewport
    const screenX = centerX + (offsetX * zoom);
    const screenY = centerY + (offsetY * zoom);
    
    return { x: screenX, y: screenY };
  }
  
  /**
   * Convert screen coordinates to world coordinates
   * @param {number} screenX - X coordinate in screen space (relative to canvas)
   * @param {number} screenY - Y coordinate in screen space (relative to canvas)
   * @returns {{ x: number, y: number }} World coordinates
   */
  function screenToWorld(screenX, screenY) {
    const canvas = $("#designCanvas");
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const { x: camX, y: camY, zoom } = state.build.camera;
    
    // Calculate offset from viewport center
    const offsetX = screenX - centerX;
    const offsetY = screenY - centerY;
    
    // Remove zoom and add camera position
    const worldX = camX + (offsetX / zoom);
    const worldY = camY + (offsetY / zoom);
    
    return { x: worldX, y: worldY };
  }

  /**
   * Update selection classes on machine elements without re-rendering
   */
  function updateSelectionClasses() {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    const container = canvas.querySelector("#canvasTransformContainer");
    if (!container) return;
    
    const selectedSet = new Set(state.build.selectedMachines);
    const selectionCount = state.build.selectedMachines.length;
    const isMultiSelect = selectionCount > 1;
    
    // Update all machine elements
    state.build.placedMachines.forEach(pm => {
      const el = container.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!el) return;
      
      const isSelected = selectedSet.has(pm.id);
      
      // Update selection class
      if (isSelected) {
        el.classList.add("is-selected");
      } else {
        el.classList.remove("is-selected");
      }
      
      // Update multi-selection badge
      if (isSelected && isMultiSelect) {
        el.classList.add("is-multi-selected");
        el.style.setProperty('--selection-count', `"${selectionCount}"`);
      } else {
        el.classList.remove("is-multi-selected");
        el.style.removeProperty('--selection-count');
      }
    });
    
    // Update create blueprint button state
    updateCreateBlueprintButton();
  }
  
  /**
   * Draw selection box during drag-to-select
   */
  function drawSelectionBox() {
    const canvas = $("#designCanvas");
    if (!canvas || !state.ui.dragState || state.ui.dragState.type !== "select") return;
    
    // Remove existing selection box
    removeSelectionBox();
    
    const { startX, startY, currentX, currentY } = state.ui.dragState;
    const canvasRect = canvas.getBoundingClientRect();
    
    const minX = Math.min(startX, currentX) - canvasRect.left;
    const maxX = Math.max(startX, currentX) - canvasRect.left;
    const minY = Math.min(startY, currentY) - canvasRect.top;
    const maxY = Math.max(startY, currentY) - canvasRect.top;
    
    const box = document.createElement("div");
    box.id = "selectionBox";
    box.style.position = "absolute";
    box.style.left = `${minX}px`;
    box.style.top = `${minY}px`;
    box.style.width = `${maxX - minX}px`;
    box.style.height = `${maxY - minY}px`;
    box.style.border = "2px dashed var(--primary)";
    box.style.background = "rgba(69, 212, 131, 0.1)";
    box.style.pointerEvents = "none";
    box.style.zIndex = "1000";
    
    canvas.appendChild(box);
  }
  
  /**
   * Remove selection box
   */
  function removeSelectionBox() {
    const box = $("#selectionBox");
    if (box) box.remove();
  }
  
  /**
   * Update camera transform without re-rendering (fast)
   */
  function updateCameraTransform() {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    const { x: camX, y: camY, zoom } = state.build.camera;
    
    // Update subtitle (only if not in blueprint edit mode)
    if (!state.currentBlueprintEdit) {
      const subtitle = $("#canvasSubtitle");
      if (subtitle) {
        const speed = getEffectiveConveyorSpeed();
        const zoomPercent = Math.round(zoom * 100);
        subtitle.innerHTML = `Conveyor: ${speed}/min | <span class="canvas__coords" title="Click to jump to coordinates">Position: (${Math.round(camX)}, ${Math.round(camY)})</span> | Zoom: ${zoomPercent}%`;
      }
    }
    
    // Get or create transform container
    let container = canvas.querySelector("#canvasTransformContainer");
    if (!container) {
      // Container doesn't exist yet, renderCanvas will create it
      return;
    }
    
    // Apply transform to container
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    // Transform: translate to viewport center, scale by zoom, then translate by camera offset
    container.style.transform = `translate(${centerX}px, ${centerY}px) scale(${zoom}) translate(${-camX}px, ${-camY}px)`;
  }
  
  /**
   * Sync render after camera movement ends - updates existing elements instead of recreating
   */
  function syncRenderAfterCameraMove() {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    const container = canvas.querySelector("#canvasTransformContainer");
    if (!container) return;
    
    // Re-render connections (these need to be redrawn as paths may have changed)
    const svgEl = container.querySelector("#connectionsSvg");
    if (svgEl) {
      renderConnections(svgEl);
    }
    
    // Update machine elements that might need state refresh
    state.build.placedMachines.forEach(pm => {
      const existingEl = container.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!existingEl) {
        // Machine doesn't exist yet, shouldn't happen but create it
        const el = createPlacedMachineElement(pm);
        container.appendChild(el);
      }
      // Note: We don't update existing elements here as their positions are handled by CSS transform
      // and their content shouldn't change during camera movement
    });
  }

  /**
   * Render canvas
   * @param {boolean} forceRecreate - If true, recreate all machine elements instead of reusing
   */
  function renderCanvas(forceRecreate = false) {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    // Update canvas subtitle
    updateBlueprintEditUI();
    
    // If no machines, show placeholder
    if (state.build.placedMachines.length === 0) {
      // Remove transform container if it exists
      const existingContainer = canvas.querySelector("#canvasTransformContainer");
      if (existingContainer) existingContainer.remove();
      
      let placeholder = canvas.querySelector(".canvas__placeholder");
      if (!placeholder) {
        placeholder = document.createElement("div");
        placeholder.className = "canvas__placeholder";
        placeholder.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 12px;">Build Your Factory</div>
          <div>Drag a machine from the left panel onto this canvas to start building.</div>
          <div class="canvas__placeholderSub">Or click the "+ Add to Canvas" button below any machine.</div>
        `;
        canvas.appendChild(placeholder);
      }
      return;
    }
    
    // Remove placeholder
    const placeholder = canvas.querySelector(".canvas__placeholder");
    if (placeholder) placeholder.remove();
    
    // Calculate machine efficiencies with backpressure system
    // This must be done before rendering machines to have efficiency data available
    calculateMachineEfficiencies();
    
    // Get or create transform container
    let container = canvas.querySelector("#canvasTransformContainer");
    const isNewContainer = !container;
    
    if (!container) {
      container = document.createElement("div");
      container.id = "canvasTransformContainer";
      container.style.position = "absolute";
      container.style.top = "0";
      container.style.left = "0";
      container.style.width = "0"; // Don't affect canvas size
      container.style.height = "0";
      container.style.transformOrigin = "0 0";
      canvas.appendChild(container);
    }
    
    // Get or create SVG for connections
    const svgNS = "http://www.w3.org/2000/svg";
    let svgEl = container.querySelector("#connectionsSvg");
    
    if (!svgEl) {
      svgEl = document.createElementNS(svgNS, "svg");
      svgEl.id = "connectionsSvg";
      svgEl.style.position = "absolute";
      svgEl.style.top = "0";
      svgEl.style.left = "0";
      svgEl.style.width = "10000px"; // Large enough for any layout
      svgEl.style.height = "10000px";
      svgEl.style.pointerEvents = "none";
      svgEl.style.zIndex = "100"; // Above machine cards (z-index: 10)
      svgEl.style.overflow = "visible";
      container.appendChild(svgEl);
    }
    
    // Reconcile machine elements (reuse existing elements where possible)
    const currentMachineIds = new Set(state.build.placedMachines.map(pm => pm.id));
    const existingElements = Array.from(container.querySelectorAll("[data-placed-machine]"));
    
    // Remove elements for machines that no longer exist
    existingElements.forEach(el => {
      const id = el.getAttribute("data-placed-machine");
      if (!currentMachineIds.has(id)) {
        el.remove();
      }
    });
    
    if (forceRecreate) {
      // Force recreate: remove all existing elements and create fresh
      existingElements.forEach(el => {
        if (currentMachineIds.has(el.getAttribute("data-placed-machine"))) {
          el.remove();
        }
      });
      
      state.build.placedMachines.forEach(pm => {
        const el = createPlacedMachineElement(pm);
        container.appendChild(el);
      });
    } else {
      // Smart update: reuse elements where possible
      state.build.placedMachines.forEach(pm => {
        let el = container.querySelector(`[data-placed-machine="${pm.id}"]`);
        
        if (el) {
          // Element exists - update position
          el.style.left = `${pm.x}px`;
          el.style.top = `${pm.y}px`;
          
          // Check if we need to update content
          const hasInsufficientInputs = checkInsufficientInputs(pm);
          const shouldHaveInsufficient = el.classList.contains("has-insufficient-inputs");
          
          // Check if efficiency changed (for underclocking display)
          const currentEfficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
          const storedEfficiency = parseFloat(el.dataset.efficiency || "1.0");
          const efficiencyChanged = Math.abs(currentEfficiency - storedEfficiency) > 0.001;
          
          // Check if storage connections changed (storage machines need full redraw when connections change)
          let storageConnectionsChanged = false;
          if (pm.type === "machine" && pm.machineId) {
            const machine = getMachineById(pm.machineId);
            if (machine && machine.kind === "storage") {
              const currentConnectionCount = 
                state.build.connections.filter(c => c.fromMachineId === pm.id || c.toMachineId === pm.id).length;
              const storedConnectionCount = parseInt(el.dataset.connectionCount || "0");
              storageConnectionsChanged = currentConnectionCount !== storedConnectionCount;
            }
          }
          
          // If state changed, recreate the element
          if (hasInsufficientInputs !== shouldHaveInsufficient || efficiencyChanged || storageConnectionsChanged) {
            const newEl = createPlacedMachineElement(pm);
            el.replaceWith(newEl);
          }
        } else {
          // Element doesn't exist - create it
          el = createPlacedMachineElement(pm);
          container.appendChild(el);
        }
      });
    }
    
    // Render connections
    renderConnections(svgEl);
    
    // Apply camera transform
    updateCameraTransform();
    
    // Ensure selection classes are synced with state
    updateSelectionClasses();
    
    // Schedule debounced production summary update if sidebar is open
    scheduleProductionSummaryUpdate();
  }
  
  function createPlacedMachineElement(placedMachine) {
    // Normalize old data
    const type = placedMachine.type || "machine";
    const count = placedMachine.count || 1;
    
    const isSelected = state.build.selectedMachines.includes(placedMachine.id);
    const hasInsufficientInputs = checkInsufficientInputs(placedMachine);
    
    const el = document.createElement("div");
    const selectionCount = state.build.selectedMachines.length;
    const isMultiSelect = isSelected && selectionCount > 1;
    el.className = `buildMachine${isSelected ? " is-selected" : ""}${hasInsufficientInputs ? " has-insufficient-inputs" : ""}`;
    el.dataset.placedMachine = placedMachine.id;
    
    // Store efficiency for change detection
    el.dataset.efficiency = String(placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0);
    
    // Store connection count for storage machines (for change detection)
    const connectionCount = state.build.connections.filter(c => 
      c.fromMachineId === placedMachine.id || c.toMachineId === placedMachine.id
    ).length;
    el.dataset.connectionCount = String(connectionCount);
    
    // Position at world coordinates (container transform handles camera)
    el.style.left = `${placedMachine.x}px`;
    el.style.top = `${placedMachine.y}px`;
    
    // Add multi-selection badge if part of a group
    if (isMultiSelect) {
      el.style.setProperty('--selection-count', `"${selectionCount}"`);
      el.classList.add('is-multi-selected');
    }
    
    // Blueprint type (black box containing other machines)
    if (type === "blueprint") {
      const bpData = placedMachine.blueprintData || {};
      const bpName = bpData.name || "Unnamed Blueprint";
      const bpDescription = bpData.description || "";
      const bpInputs = bpData.inputs || [];
      const bpOutputs = bpData.outputs || [];
      const bpMachines = bpData.machines || [];
      
      // Calculate actual machine count (with multipliers, recursively for nested blueprints)
      const blueprintId = placedMachine.blueprintId;
      const machineCounts = blueprintId ? calculateBlueprintMachineCounts(blueprintId) : { totalCount: bpMachines.length };
      const actualMachineCount = machineCounts.totalCount;
      
      // Calculate stats from contained machines
      let hasFurnaces = false;
      let hasNurseries = false;
      let totalFuelConsumption = 0;
      let totalFertilizerProduction = 0;
      let plantOutputRate = 0;
      
      bpMachines.forEach(machine => {
        const machineData = getMachineById(machine.machineId);
        if (machineData) {
          if (machineData.kind === "heating_device") {
            hasFurnaces = true;
            // Calculate fuel consumption for this machine
            let heatP = machineData.baseHeatConsumptionP || 0;
            (machine.toppers || []).forEach(topper => {
              const topperMachine = getMachineById(topper.machineId);
              if (topperMachine) {
                heatP += topperMachine.heatConsumptionP || 0;
              }
            });
            totalFuelConsumption += heatP;
          }
          if (machineData.kind === "nursery") {
            hasNurseries = true;
            // Get plant output rate
            const outputRate = getPortOutputRate(machine, "0") || 0;
            plantOutputRate += outputRate;
          }
        }
      });
      
      // Check if produces fertilizer
      bpOutputs.forEach(output => {
        const material = getMaterialById(output.materialId);
        if (material && material.kind === "fertilizer") {
          totalFertilizerProduction += output.rate;
        }
      });
      
      // Build input ports HTML (multiply rates by count)
      const inputsHTML = bpInputs.map((input, idx) => {
        const material = getMaterialById(input.materialId);
        const materialName = material ? material.name : "Unknown";
        const rate = input.rate * count;
        return `
          <div class="buildPort buildPort--input" data-input-port="${idx}" title="${materialName} - ${rate.toFixed(2)}/min">
            <div class="buildPort__dot"></div>
            <div class="buildPort__label">${escapeHtml(materialName)}</div>
            <div class="buildPort__rate">${rate.toFixed(2)}/min</div>
          </div>
        `;
      }).join("");
      
      // Build output ports HTML (multiply rates by count)
      const outputsHTML = bpOutputs.map((output, idx) => {
        const material = getMaterialById(output.materialId);
        const materialName = material ? material.name : "Unknown";
        const rate = output.rate * count;
        return `
          <div class="buildPort buildPort--output" data-output-port="${idx}" title="${materialName} - ${rate.toFixed(2)}/min">
            <div class="buildPort__label">${escapeHtml(materialName)}</div>
            <div class="buildPort__rate">${rate.toFixed(2)}/min</div>
            <div class="buildPort__dot"></div>
          </div>
        `;
      }).join("");
      
      // Build stats panels
      let statsHTML = "";
      
      if (hasFurnaces) {
        const fuelConsumption = totalFuelConsumption * count;
        statsHTML += `
          <div class="buildMachine__stats">
            <div class="buildMachine__stat">
              <div class="buildMachine__statLabel">🔥 Fuel Consumption</div>
              <div class="buildMachine__statValue">${fuelConsumption.toFixed(2)}P</div>
            </div>
          </div>
        `;
      }
      
      if (hasNurseries) {
        const plantOutput = plantOutputRate * count;
        statsHTML += `
          <div class="buildMachine__stats">
            <div class="buildMachine__stat">
              <div class="buildMachine__statLabel">🌱 Plant Output</div>
              <div class="buildMachine__statValue">${plantOutput.toFixed(2)}/min</div>
            </div>
          </div>
        `;
      }
      
      if (totalFertilizerProduction > 0) {
        const fertilizerProduction = totalFertilizerProduction * count;
        const nurseriesSupported = Math.floor(fertilizerProduction / 4.17);
        statsHTML += `
          <div class="buildMachine__stats">
            <div class="buildMachine__stat">
              <div class="buildMachine__statLabel">🌿 Fertilizer Output</div>
              <div class="buildMachine__statValue">${fertilizerProduction.toFixed(2)}/min</div>
            </div>
            <div class="buildMachine__stat">
              <div class="buildMachine__statLabel">Supports Nurseries</div>
              <div class="buildMachine__statValue">${nurseriesSupported}</div>
            </div>
          </div>
        `;
      }
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div class="buildMachine__title">📐 ${escapeHtml(bpName)} ${count > 1 ? `<span style="color: var(--accent);">(×${count})</span>` : ''}</div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="blueprint:edit" title="Edit Blueprint">✏️</button>
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          ${bpDescription ? `<div class="hint" style="margin-bottom: 8px;">${escapeHtml(bpDescription)}</div>` : ""}
          <div class="hint" style="font-style: italic; color: var(--muted);">Blueprint containing ${actualMachineCount} machine${actualMachineCount !== 1 ? 's' : ''}</div>
          <label style="font-size: 11px; color: var(--muted); display: block; margin-top: 8px; margin-bottom: 2px;">Quantity</label>
          <input type="number" min="1" max="999" step="1" value="${count}" 
            data-machine-count 
            class="buildMachine__countInput"
            style="width: 80px;" />
          ${statsHTML}
        </div>
        <div class="buildMachine__ports">
          ${bpInputs.length > 0 ? `
            <div class="buildMachine__portGroup">
              <div class="buildMachine__portLabel">Inputs</div>
              ${inputsHTML}
            </div>
          ` : ""}
          ${bpOutputs.length > 0 ? `
            <div class="buildMachine__portGroup">
              <div class="buildMachine__portLabel">Outputs</div>
              ${outputsHTML}
            </div>
          ` : ""}
        </div>
      `;
      
      return el;
    }
    
    // Purchasing Portal type
    if (type === "purchasing_portal") {
      const conveyorSpeed = getConveyorSpeed();
      const materialId = placedMachine.materialId || null;
      const material = materialId ? getMaterialById(materialId) : null;
      
      // Material selector
      const materialOptions = state.db.materials.map(m => 
        `<option value="${m.id}" ${m.id === materialId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
      ).join("");
      
      const outputsHTML = `
        <div class="buildPort buildPort--output" data-output-port="0" title="${material ? material.name : 'Select material'} - ${conveyorSpeed}/min (max belt speed)">
          <div class="buildPort__label">${material ? escapeHtml(material.name) : 'Select'}</div>
          <div class="buildPort__rate">${conveyorSpeed}/min</div>
          <div class="buildPort__dot"></div>
        </div>
      `;
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div class="buildMachine__title">Purchasing Portal</div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px;">Material to Purchase</label>
          <select class="buildMachine__recipeSelect" data-portal-material-select>
            <option value="">(select material)</option>
            ${materialOptions}
          </select>
          <div class="hint" style="margin-top: 6px;">Outputs at max belt speed (${conveyorSpeed}/min). Assumes infinite coins.</div>
        </div>
        <div class="buildMachine__ports">
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Output</div>
            ${outputsHTML}
          </div>
        </div>
      `;
      
      return el;
    }
    
    // Fuel Source type
    if (type === "fuel_source") {
      const fuelId = placedMachine.fuelId || null;
      const fuel = fuelId ? getMaterialById(fuelId) : null;
      
      // Calculate total fuel consumption from all connected machines
      let totalConsumptionP = 0;
      const connections = state.build.connections.filter(conn => conn.fromMachineId === placedMachine.id);
      
      connections.forEach(conn => {
        const targetMachine = state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
        if (!targetMachine) return;
        
        const machine = getMachineById(targetMachine.machineId);
        if (machine && machine.kind === "heating_device") {
          // Calculate total heat consumption for this heating device with skill modifier
          let heatP = getFuelConsumptionRate(machine.baseHeatConsumptionP || 1);
          (targetMachine.toppers || []).forEach(topper => {
            const topperMachine = getMachineById(topper.machineId);
            if (topperMachine) {
              heatP += getFuelConsumptionRate(topperMachine.heatConsumptionP || 0);
            }
          });
          totalConsumptionP += heatP;
        }
      });
      
      // Calculate fuel rate: items per minute needed
      let fuelRate = 0;
      if (fuel && fuel.fuelValue && totalConsumptionP > 0) {
        // Formula: 60 / (fuelValue / consumptionRate)
        // = (60 * consumptionRate) / fuelValue
        const adjustedFuelValue = getFuelHeatValue(fuel.fuelValue);
        fuelRate = (60 * totalConsumptionP) / adjustedFuelValue;
      }
      
      // Fuel selector (only show fuels)
      const fuelOptions = state.db.materials
        .filter(m => m.isFuel)
        .map(m => `<option value="${m.id}" ${m.id === fuelId ? 'selected' : ''}>${escapeHtml(m.name)} (${getFuelHeatValue(m.fuelValue)}P)</option>`)
        .join("");
      
      const outputsHTML = `
        <div class="buildPort buildPort--output" data-output-port="0" title="${fuel ? fuel.name : 'Select fuel'} - ${fuelRate.toFixed(2)}/min">
          <div class="buildPort__label">${fuel ? escapeHtml(fuel.name) : 'Select'}</div>
          <div class="buildPort__rate">${fuelRate.toFixed(2)}/min</div>
          <div class="buildPort__dot"></div>
        </div>
      `;
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div class="buildMachine__title">Fuel Source</div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px;">Fuel Type</label>
          <select class="buildMachine__recipeSelect" data-fuel-material-select>
            <option value="">(select fuel)</option>
            ${fuelOptions}
          </select>
          <div class="hint" style="margin-top: 6px;">
            ${totalConsumptionP > 0 ? `Feeding ${totalConsumptionP.toFixed(1)}P/s consumption.` : 'Connect to heating devices.'}
            ${fuel && totalConsumptionP > 0 ? `<br>Each ${fuel.name} lasts ${((getFuelHeatValue(fuel.fuelValue)) / totalConsumptionP).toFixed(1)}s` : ''}
          </div>
        </div>
        <div class="buildMachine__ports">
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Output</div>
            ${outputsHTML}
          </div>
        </div>
      `;
      
      return el;
    }
    
    // Nursery type
    if (type === "nursery") {
      const plantId = placedMachine.plantId || null;
      const plant = plantId ? getMaterialById(plantId) : null;
      
      // Get fertilizer from connected input OR selected fertilizer
      let fertilizerMaterial = null;
      let isConnected = false;
      const incomingConnections = state.build.connections.filter(conn => conn.toMachineId === placedMachine.id);
      if (incomingConnections.length > 0) {
        const sourceConn = incomingConnections[0];
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
        if (sourceMachine) {
          const fertId = getMaterialIdFromPort(sourceMachine, sourceConn.fromPortIdx, "output");
          if (fertId) {
            fertilizerMaterial = getMaterialById(fertId);
            isConnected = true;
          }
        }
      }
      
      // If no connection, use selected fertilizer
      if (!fertilizerMaterial && placedMachine.fertilizerId) {
        fertilizerMaterial = getMaterialById(placedMachine.fertilizerId);
      }
      
      // Calculate production rates
      let plantOutputRate = 0;
      let fertilizerInputRate = 0;
      let growthTime = 0;
      let nurseriesPerBelt = 0;
      let fertilizerDuration = 0;
      
      if (plant && plant.plantRequiredNutrient && fertilizerMaterial && fertilizerMaterial.fertilizerMaxFertility) {
        const Nv = plant.plantRequiredNutrient; // Required nutrients (V)
        const Ff = fertilizerMaterial.fertilizerMaxFertility; // Fertility rate (V/s) - NOT affected by skill
        const Fv = getFertilizerValue(fertilizerMaterial.fertilizerNutrientValue || 0); // Nutrient value (V) - IS affected by skill
        
        // Plant Growth Time = Nv / Ff
        growthTime = Nv / Ff;
        
        // Output Rate = 60 / growthTime (per nursery)
        const outputPerNursery = 60 / growthTime;
        plantOutputRate = outputPerNursery * count;
        
        // Fertilizer duration = Fv / Ff
        fertilizerDuration = Fv / Ff;
        
        // Required Fertilizer p/m = 60 / fertilizerDuration (per nursery)
        const inputPerNursery = 60 / fertilizerDuration;
        fertilizerInputRate = inputPerNursery * count;
        
        // Calculate how many nurseries one full belt can support (single nursery basis)
        const beltSpeed = getConveyorSpeed();
        nurseriesPerBelt = Math.floor(beltSpeed / inputPerNursery);
      }
      
      // Plant selector (only show plants)
      const plantOptions = state.db.materials
        .filter(m => m.isPlant)
        .map(m => `<option value="${m.id}" ${m.id === plantId ? 'selected' : ''}>${escapeHtml(m.name)} (${m.plantRequiredNutrient}V)</option>`)
        .join("");
      
      // Fertilizer selector (only show fertilizers)
      const fertilizerOptions = state.db.materials
        .filter(m => m.isFertilizer)
        .map(m => `<option value="${m.id}" ${m.id === placedMachine.fertilizerId ? 'selected' : ''}>${escapeHtml(m.name)} (${getFertilizerValue(m.fertilizerNutrientValue)}V, ${m.fertilizerMaxFertility}V/s)</option>`)
        .join("");
      
      const inputsHTML = `
        <div class="buildPort buildPort--input" data-input-port="0" title="Fertilizer input">
          <div class="buildPort__dot"></div>
          <div class="buildPort__label">Fertilizer</div>
          <div class="buildPort__rate">${fertilizerInputRate > 0 ? fertilizerInputRate.toFixed(2) : '—'}/min</div>
        </div>
      `;
      
      const outputsHTML = `
        <div class="buildPort buildPort--output" data-output-port="0" title="${plant ? plant.name : 'Select plant'} - ${plantOutputRate.toFixed(2)}/min">
          <div class="buildPort__label">${plant ? escapeHtml(plant.name) : 'Select'}</div>
          <div class="buildPort__rate">${plantOutputRate.toFixed(2)}/min</div>
          <div class="buildPort__dot"></div>
        </div>
      `;
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <div class="buildMachine__title">Nursery</div>
            <input 
              type="number" 
              class="buildMachine__countInput" 
              data-machine-count 
              value="${count}" 
              min="1" 
              max="999" 
              title="Number of nurseries"
            />
          </div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px;">Plant Type</label>
          <select class="buildMachine__recipeSelect" data-nursery-plant-select>
            <option value="">(select plant)</option>
            ${plantOptions}
          </select>
          
          ${!isConnected ? `
            <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px; margin-top: 12px;">Fertilizer Type (Preview)</label>
            <select class="buildMachine__recipeSelect" data-nursery-fertilizer-select>
              <option value="">(select fertilizer)</option>
              ${fertilizerOptions}
            </select>
          ` : ''}
          
          <div class="hint" style="margin-top: 6px;">
            ${plant && fertilizerMaterial ? `
              Growth Time: ${growthTime.toFixed(1)}s<br>
              Output: ${plantOutputRate.toFixed(2)} ${plant.name}/min<br>
              Requires: ${fertilizerInputRate.toFixed(2)} ${fertilizerMaterial.name}/min<br>
              1 ${fertilizerMaterial.name} lasts ${fertilizerDuration.toFixed(1)}s<br>
              <strong>One belt (${getConveyorSpeed()}/min) supports ${nurseriesPerBelt} nurseries</strong>
            ` : plant && !isConnected ? `Select fertilizer to see production rates` : plant ? `Connect fertilizer to see production rates` : `Select a plant to begin`}
          </div>
        </div>
        <div class="buildMachine__ports">
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Input</div>
            ${inputsHTML}
          </div>
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Output</div>
            ${outputsHTML}
          </div>
        </div>
      `;
      
      return el;
    }
    
    const machine = placedMachine.machineId ? getMachineById(placedMachine.machineId) : null;
    
    // Storage machine type (machine with kind === "storage")
    if (machine && machine.kind === "storage") {
      const maxSlots = machine.storageSlots || 0;
      const currentSlots = placedMachine.storageSlots || maxSlots;
      const inventories = placedMachine.inventories || [];
      
      // Generate input/output ports with per-port rates
      const inputsHTML = Array.from({ length: machine.inputs }, (_, idx) => `
        <div class="buildPort buildPort--input" data-input-port="${idx}" title="Input ${idx + 1}">
          <div class="buildPort__dot"></div>
          <div class="buildPort__label">In ${idx + 1}</div>
        </div>
      `).join("");
      
      const outputsHTML = Array.from({ length: machine.outputs }, (_, idx) => {
        const portRate = calculateStoragePortOutputRate(placedMachine, idx);
        return `
          <div class="buildPort buildPort--output" data-output-port="${idx}" title="Output ${idx + 1}${portRate > 0 ? ` - ${portRate.toFixed(1)}/min` : ''}">
            <div class="buildPort__label">Out ${idx + 1}</div>
            ${portRate > 0 ? `<div class="buildPort__rate">${portRate.toFixed(1)}/min</div>` : ''}
            <div class="buildPort__dot"></div>
          </div>
        `;
      }).join("");
      
      // Check if storage has inputs connected
      const hasInputs = state.build.connections.some(
        conn => conn.toMachineId === placedMachine.id
      );
      
      // Calculate real-time inventory status
      const calculatedInventories = calculateStorageInventory(placedMachine);
      let inventoryHTML = '';
      
      if (!hasInputs) {
        // No inputs - allow manual material management
        const manualInventories = placedMachine.manualInventories || [];
        
        if (manualInventories.length > 0 && calculatedInventories.length > 0) {
          inventoryHTML = calculatedInventories.map((inv, idx) => {
            return `
              <div class="storageInventory__item storageInventory__item--manual">
                <div>
                  <div class="storageInventory__material">${escapeHtml(inv.materialName)}</div>
                  <div class="storageInventory__status">${inv.currentAmount} / ${inv.capacity} items (${inv.slotsAllocated} slot${inv.slotsAllocated > 1 ? 's' : ''})</div>
                  ${inv.storedDisplay ? `<div class="storageInventory__time">${inv.storedDisplay}</div>` : ''}
                  ${inv.timeDisplay ? `<div class="storageInventory__time">${inv.timeDisplay}</div>` : ''}
                </div>
                <button class="btn btn--danger btn--sm" data-action="storage:remove-manual" data-manual-idx="${idx}" title="Remove">✕</button>
              </div>
            `;
          }).join("");
        }
        
        inventoryHTML += `
          <button class="btn btn--sm" data-action="storage:add-manual" style="margin-top: 8px;">+ Add Material</button>
        `;
      } else {
        // Has inputs - show calculated inventories
        if (calculatedInventories.length > 0) {
          inventoryHTML = calculatedInventories.map(inv => {
            return `
              <div class="storageInventory__item">
                <div class="storageInventory__material">${escapeHtml(inv.materialName)}</div>
                <div class="storageInventory__status">${inv.currentAmount} / ${inv.capacity} items (${inv.slotsAllocated} slot${inv.slotsAllocated > 1 ? 's' : ''})</div>
                <div class="storageInventory__time">${inv.timeDisplay}</div>
              </div>
            `;
          }).join("");
        } else {
          inventoryHTML = '<div class="hint">No materials flowing yet</div>';
        }
      }
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <div class="buildMachine__title">${escapeHtml(machine.name)} (Storage)</div>
            <button class="btn btn--sm" data-action="storage:change-type" title="Change storage type">✏️</button>
          </div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <div class="field" style="margin-bottom: 12px;">
            <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px;">Storage Slots (max: ${maxSlots})</label>
            <input 
              type="number" 
              class="buildMachine__storageSlots" 
              data-storage-slots 
              value="${currentSlots}" 
              min="1" 
              max="${maxSlots}"
            />
          </div>
          
          <div class="storageInventory">
            <div class="storageInventory__title">Capacity Status</div>
            ${inventoryHTML}
          </div>
        </div>
        <div class="buildMachine__ports">
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Inputs</div>
            ${inputsHTML}
          </div>
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Outputs</div>
            ${outputsHTML}
          </div>
        </div>
      `;
      
      return el;
    }
    
    // Heating Device machine type (machine with kind === "heating_device")
    if (machine && machine.kind === "heating_device") {
      const toppers = placedMachine.toppers || [];
      const heatingAreaWidth = machine.heatingAreaWidth || 1;
      const heatingAreaLength = machine.heatingAreaLength || 1;
      const totalArea = heatingAreaWidth * heatingAreaLength;
      
      // Calculate used area and total heat consumption
      let usedArea = 0;
      let totalHeatP = getFuelConsumptionRate(machine.baseHeatConsumptionP || 1);
      
      toppers.forEach(topper => {
        const topperMachine = getMachineById(topper.machineId);
        if (topperMachine) {
          const footprintWidth = topperMachine.footprintWidth || 1;
          const footprintLength = topperMachine.footprintLength || 1;
          usedArea += footprintWidth * footprintLength;
          totalHeatP += getFuelConsumptionRate(topperMachine.heatConsumptionP || 0);
        }
      });
      
      // Multiply total heat by count (representing multiple furnaces)
      totalHeatP *= count;
      
      // Render toppers list
      const toppersHTML = toppers.length > 0 ? toppers.map((topper, idx) => {
        const topperMachine = getMachineById(topper.machineId);
        if (!topperMachine) return '';
        
        const footprintArea = (topperMachine.footprintWidth || 1) * (topperMachine.footprintLength || 1);
        
        // Get available recipes for this topper machine
        const topperRecipes = state.db.recipes.filter(r => r.machineId === topper.machineId);
        const recipeOptions = topperRecipes.map(r => 
          `<option value="${r.id}" ${r.id === topper.recipeId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
        ).join("");
        
        return `
          <div class="storageInventory__item">
            <div style="display: flex; flex-direction: column; gap: 6px; flex: 1;">
              <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="flex: 1;">
                  <div class="storageInventory__material">${escapeHtml(topperMachine.name)}</div>
                  <div class="storageInventory__status">${footprintArea} tile${footprintArea > 1 ? 's' : ''} • ${getFuelConsumptionRate(topperMachine.heatConsumptionP || 0).toFixed(1)}P</div>
                </div>
                <button class="btn btn--danger btn--sm" data-action="heating:remove-topper" data-topper-idx="${idx}" title="Remove">✕</button>
              </div>
              ${topperRecipes.length > 0 ? `
                <select class="buildMachine__recipeSelect" data-topper-recipe-select data-topper-idx="${idx}" style="font-size: 11px; padding: 6px 8px;">
                  <option value="">(no recipe)</option>
                  ${recipeOptions}
                </select>
              ` : '<div class="hint" style="margin: 0;">No recipes configured for this machine</div>'}
            </div>
          </div>
        `;
      }).join("") : '<div class="hint" style="padding: 8px;">No toppers added</div>';
      
      // Available machines that can be added as toppers (requiresFurnace = true)
      const availableToppers = state.db.machines.filter(m => m.requiresFurnace);
      
      // Render ports for toppers
      let topperInputsHTML = [];
      let topperOutputsHTML = [];
      
      // Group inputs and outputs by material
      const groupedInputs = {}; // materialId -> { rate: total, toppers: [{topperIdx, portIdx, topperName}] }
      const groupedOutputs = {}; // materialId -> { rate: total, toppers: [{topperIdx, portIdx, topperName}] }
      
      toppers.forEach((topper, topperIdx) => {
        const topperMachine = getMachineById(topper.machineId);
        const topperRecipe = topper.recipeId ? getRecipeById(topper.recipeId) : null;
        
        if (!topperMachine || !topperRecipe) return;
        
        const effectiveTime = getEffectiveProcessingTime(topperRecipe.processingTimeSec);
        
        // Collect inputs for this topper
        topperRecipe.inputs.forEach((inp, portIdx) => {
          if (!inp.materialId) return;
          const rate = (inp.items / effectiveTime) * 60 * count; // Multiply by furnace count
          
          if (!groupedInputs[inp.materialId]) {
            groupedInputs[inp.materialId] = { rate: 0, toppers: [] };
          }
          groupedInputs[inp.materialId].rate += rate;
          groupedInputs[inp.materialId].toppers.push({
            topperIdx,
            portIdx,
            topperName: topperMachine.name
          });
        });
        
        // Collect outputs for this topper
        topperRecipe.outputs.forEach((out, portIdx) => {
          if (!out.materialId) return;
          const rate = (out.items / effectiveTime) * 60 * count; // Multiply by furnace count
          
          if (!groupedOutputs[out.materialId]) {
            groupedOutputs[out.materialId] = { rate: 0, toppers: [] };
          }
          groupedOutputs[out.materialId].rate += rate;
          groupedOutputs[out.materialId].toppers.push({
            topperIdx,
            portIdx,
            topperName: topperMachine.name
          });
        });
      });
      
      // Generate grouped input ports
      for (const materialId in groupedInputs) {
        const material = getMaterialById(materialId);
        const data = groupedInputs[materialId];
        const rate = data.rate.toFixed(1);
        const count = data.toppers.length;
        const topperNames = [...new Set(data.toppers.map(t => t.topperName))].join(', ');
        
        topperInputsHTML.push(`
          <div class="buildPort buildPort--input" data-input-port="grouped-input-${materialId}" title="${material ? material.name : '(none)'} - ${rate}/min (${count} topper${count > 1 ? 's' : ''})">
            <div class="buildPort__dot"></div>
            <div class="buildPort__label">${material ? material.name : '?'}</div>
            <div class="buildPort__rate">${rate}/min</div>
            <div style="font-size: 9px; color: var(--muted); margin-top: 1px;">${count}× ${escapeHtml(topperNames)}</div>
          </div>
        `);
      }
      
      // Generate grouped output ports
      for (const materialId in groupedOutputs) {
        const material = getMaterialById(materialId);
        const data = groupedOutputs[materialId];
        const rate = data.rate.toFixed(1);
        const count = data.toppers.length;
        const topperNames = [...new Set(data.toppers.map(t => t.topperName))].join(', ');
        
        topperOutputsHTML.push(`
          <div class="buildPort buildPort--output" data-output-port="grouped-output-${materialId}" title="${material ? material.name : '(none)'} - ${rate}/min (${count} topper${count > 1 ? 's' : ''})">
            <div class="buildPort__label">${material ? material.name : '?'}</div>
            <div class="buildPort__rate">${rate}/min</div>
            <div style="font-size: 9px; color: var(--muted); margin-top: 1px;">${count}× ${escapeHtml(topperNames)}</div>
            <div class="buildPort__dot"></div>
          </div>
        `);
      }
      
      // Check if fuel input has any connections
      const fuelConnections = state.build.connections.filter(
        conn => conn.toMachineId === placedMachine.id && conn.toPortIdx === "fuel"
      );
      const hasFuelConnection = fuelConnections.length > 0;
      
      // Fuel info display (selector when not connected, rate display when connected)
      let fuelInfoHTML = '';
      
      if (hasFuelConnection && totalHeatP > 0) {
        // Fuel is connected - show incoming fuel and required rate
        const fuelConn = fuelConnections[0];
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === fuelConn.fromMachineId);
        
        if (sourceMachine) {
          // Determine what fuel material is being supplied
          const fuelMaterialId = getMaterialIdFromPort(sourceMachine, fuelConn.fromPortIdx, "output");
          const fuelMaterial = fuelMaterialId ? getMaterialById(fuelMaterialId) : null;
          
          if (fuelMaterial && fuelMaterial.fuelValue) {
            // Calculate required rate for this fuel
            const adjustedFuelValue = getFuelHeatValue(fuelMaterial.fuelValue);
            const requiredRate = (60 * totalHeatP) / adjustedFuelValue;
            
            // Get actual incoming rate
            const incomingRate = getPortOutputRate(sourceMachine, fuelConn.fromPortIdx);
            
            // Check for shortage
            const hasShortage = incomingRate < requiredRate - 0.01; // Small tolerance for float comparison
            const shortageAmount = hasShortage ? requiredRate - incomingRate : 0;
            
            fuelInfoHTML = `
              <div style="margin-bottom: 8px; padding: 8px; background: ${hasShortage ? 'rgba(255,90,106,.1)' : 'rgba(69,212,131,.1)'}; border: 1px solid ${hasShortage ? 'rgba(255,90,106,.3)' : 'rgba(69,212,131,.3)'}; border-radius: 8px;">
                <div style="font-size: 11px; color: var(--muted); margin-bottom: 4px;">FUEL: ${escapeHtml(fuelMaterial.name)}</div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="font-size: 12px; font-weight: 600;">Required: ${requiredRate.toFixed(2)}/min</div>
                    <div style="font-size: 12px; font-weight: 600; color: ${hasShortage ? 'var(--danger)' : 'var(--ok)'};">Incoming: ${incomingRate.toFixed(2)}/min</div>
                  </div>
                  ${hasShortage ? `<div style="color: var(--danger); font-size: 18px;" title="Fuel shortage!">⚠️</div>` : `<div style="color: var(--ok); font-size: 18px;" title="Sufficient fuel">✓</div>`}
                </div>
                ${hasShortage ? `<div style="margin-top: 4px; font-size: 11px; color: var(--danger); font-weight: 600;">⚠️ SHORT BY ${shortageAmount.toFixed(2)}/min</div>` : ''}
              </div>
            `;
          } else {
            // Connected but not to a valid fuel source
            fuelInfoHTML = `
              <div style="margin-bottom: 8px; padding: 8px; background: rgba(255,165,0,.1); border: 1px solid rgba(255,165,0,.3); border-radius: 8px;">
                <div style="font-size: 11px; color: var(--muted);">⚠️ Connected input is not a fuel source</div>
              </div>
            `;
          }
        }
      } else if (!hasFuelConnection && totalHeatP > 0) {
        // No fuel connection - show preview selector
        const selectedFuelId = placedMachine.previewFuelId || null;
        const selectedFuel = selectedFuelId ? getMaterialById(selectedFuelId) : null;
        
        let fuelRateDisplay = '';
        // Calculate required fuel rate if a fuel is selected
        if (selectedFuel && selectedFuel.fuelValue) {
          const adjustedFuelValue = getFuelHeatValue(selectedFuel.fuelValue);
          const fuelRate = (60 * totalHeatP) / adjustedFuelValue;
          fuelRateDisplay = `Requires ${fuelRate.toFixed(2)} ${selectedFuel.name}/min`;
        }
        
        const fuelOptions = state.db.materials
          .filter(m => m.isFuel)
          .map(m => `<option value="${m.id}" ${m.id === selectedFuelId ? 'selected' : ''}>${escapeHtml(m.name)} (${getFuelHeatValue(m.fuelValue)}P)</option>`)
          .join("");
        
        fuelInfoHTML = `
          <div style="margin-bottom: 8px; padding: 8px; background: rgba(255,165,0,.1); border: 1px solid rgba(255,165,0,.3); border-radius: 8px;">
            <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px;">Preview Fuel (No Connection)</label>
            <select class="buildMachine__recipeSelect" data-heating-fuel-select style="font-size: 11px; padding: 6px 8px; margin-bottom: 4px;">
              <option value="">(select fuel to preview)</option>
              ${fuelOptions}
            </select>
            ${fuelRateDisplay ? `<div class="hint" style="margin: 0; color: var(--accent);">${fuelRateDisplay}</div>` : ''}
          </div>
        `;
      }
      
      // Fuel input port (always present)
      const fuelInputHTML = `
        <div class="buildPort buildPort--input" data-input-port="fuel" title="Fuel - ${totalHeatP.toFixed(1)}P consumption">
          <div class="buildPort__dot"></div>
          <div class="buildPort__label">Fuel</div>
          <div class="buildPort__rate">${totalHeatP.toFixed(1)}P</div>
        </div>
      `;
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
            <div class="buildMachine__title">${escapeHtml(machine.name)}</div>
            <input 
              type="number" 
              class="buildMachine__countInput" 
              data-machine-count 
              value="${count}" 
              min="1" 
              max="999" 
              title="Number of ${machine.name}s"
            />
          </div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <div>
              <div style="font-size: 11px; color: var(--muted); font-weight: 600;">AREA</div>
              <div style="font-size: 14px; font-weight: 700; color: ${usedArea > totalArea ? 'var(--danger)' : 'var(--ok)'};">${usedArea} / ${totalArea} tiles</div>
            </div>
            <div>
              <div style="font-size: 11px; color: var(--muted); font-weight: 600;">HEAT</div>
              <div style="font-size: 14px; font-weight: 700;">${totalHeatP.toFixed(1)}P</div>
            </div>
          </div>
          
          ${usedArea > totalArea ? '<div style="color: var(--danger); font-size: 11px; margin-bottom: 8px; font-weight: 600;">⚠️ Exceeds heating area capacity!</div>' : ''}
          
          ${fuelInfoHTML}
          
          <div class="storageInventory">
            <div class="storageInventory__title">Toppers (${toppers.length})</div>
            ${toppersHTML}
          </div>
          
          ${availableToppers.length > 0 ? `
            <button class="btn btn--primary btn--sm" data-action="heating:add-topper" style="width: 100%; margin-top: 8px;">+ Add Topper</button>
          ` : '<div class="hint" style="margin-top: 8px;">No topper machines defined</div>'}
        </div>
        <div class="buildMachine__ports">
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Inputs</div>
            ${fuelInputHTML}
            ${topperInputsHTML.join("")}
            ${topperInputsHTML.length === 0 ? '<div class="hint" style="padding: 4px 8px;">Add toppers with recipes</div>' : ''}
          </div>
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Outputs</div>
            ${topperOutputsHTML.join("")}
            ${topperOutputsHTML.length === 0 ? '<div class="hint" style="padding: 4px 8px;">Add toppers with recipes</div>' : ''}
          </div>
        </div>
      `;
      
      return el;
    }
    
    // If no machine selected, show machine selector
    if (!machine) {
      // Filter machines: only show Standard, Storage, and Heating Device types (not machines that require heating)
      const machineOptions = state.db.machines
        .filter(m => !m.requiresFurnace) // Exclude machines that must be placed on heating devices
        .map(m => 
          `<option value="${m.id}">${escapeHtml(m.name)}</option>`
        ).join("");
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div class="buildMachine__title">New Machine</div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <label style="font-size: 11px; color: var(--muted); display: block; margin-bottom: 4px;">Select Machine Type</label>
          <select class="buildMachine__recipeSelect" data-machine-select>
            <option value="">(select machine)</option>
            ${machineOptions}
          </select>
        </div>
      `;
      
      return el;
    }
    
    const recipe = placedMachine.recipeId ? getRecipeById(placedMachine.recipeId) : null;
    const effectiveTime = recipe ? getEffectiveProcessingTime(recipe.processingTimeSec) : 0;
    
    const inputsHTML = recipe ? recipe.inputs.map((inp, idx) => {
      const material = getMaterialById(inp.materialId);
      const rate = ((inp.items / effectiveTime) * 60 * count).toFixed(1);
      return `
        <div class="buildPort buildPort--input" data-input-port="${idx}" title="${material ? material.name : '(none)'} - ${rate}/min">
          <div class="buildPort__dot"></div>
          <div class="buildPort__label">${material ? material.name : '?'}</div>
          <div class="buildPort__rate">${rate}/min</div>
        </div>
      `;
    }).join("") : '<div class="hint" style="padding: 4px 8px;">Select recipe</div>';
    
    const outputsHTML = recipe ? recipe.outputs.map((out, idx) => {
      const material = getMaterialById(out.materialId);
      const rate = ((out.items / effectiveTime) * 60 * count).toFixed(1);
      return `
        <div class="buildPort buildPort--output" data-output-port="${idx}" title="${material ? material.name : '(none)'} - ${rate}/min">
          <div class="buildPort__label">${material ? material.name : '?'}</div>
          <div class="buildPort__rate">${rate}/min</div>
          <div class="buildPort__dot"></div>
        </div>
      `;
    }).join("") : '<div class="hint" style="padding: 4px 8px;">Select recipe</div>';
    
    // Get recipes for this machine
    const availableRecipes = state.db.recipes.filter(r => r.machineId === machine.id);
    const recipeOptions = availableRecipes.map(r => 
      `<option value="${r.id}" ${r.id === placedMachine.recipeId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
    ).join("");
    
    const efficiency = placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0;
    const efficiencyPercent = (efficiency * 100).toFixed(1);
    const isUnderclocked = efficiency < 0.999; // Show if less than 99.9%
    
    el.innerHTML = `
      <div class="buildMachine__header">
        <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
          <div class="buildMachine__title">${escapeHtml(machine.name)}</div>
          ${hasInsufficientInputs ? '<span class="buildMachine__warning" title="Insufficient inputs: upstream production or belt speed cannot meet demand">⚠️</span>' : ''}
          ${isUnderclocked ? `<span style="font-size: 10px; padding: 2px 6px; background: rgba(255,165,0,0.2); border: 1px solid rgba(255,165,0,0.4); border-radius: 4px; color: #ffa500; font-weight: 600;" title="Machine is underclocked due to insufficient downstream demand">${efficiencyPercent}%</span>` : ''}
          <input 
            type="number" 
            class="buildMachine__countInput" 
            data-machine-count 
            value="${count}" 
            min="1" 
            max="999" 
            title="Number of machines"
          />
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
          <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
        </div>
      </div>
      <div class="buildMachine__body">
        <select class="buildMachine__recipeSelect" data-machine-recipe-select>
          <option value="">(select recipe)</option>
          ${recipeOptions}
        </select>
      </div>
      <div class="buildMachine__ports">
        <div class="buildMachine__portGroup">
          <div class="buildMachine__portLabel">Inputs</div>
          ${inputsHTML}
        </div>
        <div class="buildMachine__portGroup">
          <div class="buildMachine__portLabel">Outputs</div>
          ${outputsHTML}
        </div>
      </div>
    `;
    
    return el;
  }
  
  /**
   * Get obstacle rectangles for pathfinding (machine cards with clearance)
   */
  function getObstacles(excludeMachineIds = []) {
    const CLEARANCE = 16;
    const obstacles = [];
    
    // Use machine data directly for world coordinates
    state.build.placedMachines.forEach(pm => {
      // Skip excluded machines (source/target of current connection)
      if (excludeMachineIds.includes(pm.id)) return;
      
      // Get machine element to determine size (use DOM dimensions, not transformed)
      const machineEl = document.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!machineEl) return;
      
      // Use offsetWidth/Height which gives element dimensions without transform effects
      const worldWidth = machineEl.offsetWidth;
      const worldHeight = machineEl.offsetHeight;
      
      obstacles.push({
        x1: pm.x - CLEARANCE,
        y1: pm.y - CLEARANCE,
        x2: pm.x + worldWidth + CLEARANCE,
        y2: pm.y + worldHeight + CLEARANCE,
      });
    });
    
    return obstacles;
  }
  
  /**
   * Find an orthogonal path between two points avoiding obstacles
   * Enforces: outputs exit right for 16px min, inputs enter left for 16px min
   * Pattern: RIGHT → VERTICAL → RIGHT
   */
  function findPath(x1, y1, x2, y2, obstacles, fromCardRight = null, toCardLeft = null) {
    const MIN_BUFFER = 16;
    const points = [];
    
    // Start point (output - exits to the right)
    points.push({ x: x1, y: y1 });
    
    // Add buffer point to the right of output
    const outputBufferX = x1 + MIN_BUFFER;
    points.push({ x: outputBufferX, y: y1 });
    
    // End point needs to enter from the left
    const inputBufferX = x2 - MIN_BUFFER;
    
    if (outputBufferX < inputBufferX) {
      // Normal left-to-right flow
      // Strategy: RIGHT → VERTICAL → RIGHT
      
      // Find the midpoint X for the vertical segment
      // Use card positions if available, otherwise use buffer positions
      let turnX;
      if (fromCardRight !== null && toCardLeft !== null) {
        // True midpoint between cards
        turnX = (fromCardRight + toCardLeft) / 2;
      } else {
        turnX = (outputBufferX + inputBufferX) / 2;
      }
      
      // Check if we need to route around obstacles
      // Check entire Z-pattern path for obstacles
      let needsRouting = false;
      let obstacleMaxX = outputBufferX;
      
      for (const obs of obstacles) {
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        
        // Check if obstacle blocks our vertical path at turnX
        if (turnX >= obs.x1 && turnX <= obs.x2 && 
            ((minY >= obs.y1 && minY <= obs.y2) || 
             (maxY >= obs.y1 && maxY <= obs.y2) ||
             (minY <= obs.y1 && maxY >= obs.y2))) {
          needsRouting = true;
          obstacleMaxX = Math.max(obstacleMaxX, obs.x2);
        }
        
        // Check if obstacle blocks first horizontal segment (outputBufferX to turnX at y1)
        if (y1 >= obs.y1 && y1 <= obs.y2 && 
            outputBufferX < obs.x2 && turnX > obs.x1) {
          needsRouting = true;
          obstacleMaxX = Math.max(obstacleMaxX, obs.x2);
        }
        
        // Check if obstacle blocks last horizontal segment (turnX to inputBufferX at y2)
        if (y2 >= obs.y1 && y2 <= obs.y2 && 
            turnX < obs.x2 && inputBufferX > obs.x1) {
          needsRouting = true;
          obstacleMaxX = Math.max(obstacleMaxX, obs.x2);
        }
      }
      
      if (needsRouting) {
        // Move turn point past the obstacle
        turnX = obstacleMaxX + 30;
        
        // If we've pushed too far right, route around
        if (turnX > inputBufferX) {
          // Route above or below
          let clearY = null;
          for (let offset = 30; offset <= 200; offset += 30) {
            let testY = Math.min(y1, y2) - offset;
            if (isHorizontalClear(outputBufferX, inputBufferX, testY, obstacles)) {
              clearY = testY;
              break;
            }
            testY = Math.max(y1, y2) + offset;
            if (isHorizontalClear(outputBufferX, inputBufferX, testY, obstacles)) {
              clearY = testY;
              break;
            }
          }
          
          if (clearY !== null) {
            const extendX = 30;
            points.push({ x: outputBufferX + extendX, y: y1 });
            points.push({ x: outputBufferX + extendX, y: clearY });
            points.push({ x: inputBufferX - extendX, y: clearY });
            points.push({ x: inputBufferX - extendX, y: y2 });
            points.push({ x: inputBufferX, y: y2 });
            points.push({ x: x2, y: y2 });
            return points;
          }
          
          // Fallback: just use midpoint
          turnX = (outputBufferX + inputBufferX) / 2;
        }
      }
      
      // Apply vertical line offset to avoid overlaps
      turnX = getOffsetVerticalX(turnX, Math.min(y1, y2), Math.max(y1, y2));
      
      // Simple Z-pattern: RIGHT → VERTICAL → RIGHT
      points.push({ x: turnX, y: y1 });      // Horizontal to turn point
      points.push({ x: turnX, y: y2 });      // Vertical to target Y
      points.push({ x: inputBufferX, y: y2 }); // Horizontal to input buffer
      
    } else {
      // Output is to the right of input - need to loop back
      const rightExtension = Math.max(outputBufferX, x1 + 40);
      points.push({ x: rightExtension, y: y1 });
      
      // Find a clear Y position to route across
      let clearY = null;
      for (let offset = 30; offset <= 200; offset += 30) {
        let testY = Math.min(y1, y2) - offset;
        if (isHorizontalClear(rightExtension, inputBufferX - 30, testY, obstacles)) {
          clearY = testY;
          break;
        }
        testY = Math.max(y1, y2) + offset;
        if (isHorizontalClear(rightExtension, inputBufferX - 30, testY, obstacles)) {
          clearY = testY;
          break;
        }
      }
      
      if (clearY !== null) {
        // Route with proper spacing before final approach
        const approachX = inputBufferX - 30;
        points.push({ x: rightExtension, y: clearY });
        points.push({ x: approachX, y: clearY });
        points.push({ x: approachX, y: y2 });
        points.push({ x: inputBufferX, y: y2 });
      } else {
        const loopY = Math.max(y1, y2) + 50;
        const approachX = inputBufferX - 30;
        points.push({ x: rightExtension, y: loopY });
        points.push({ x: approachX, y: loopY });
        points.push({ x: approachX, y: y2 });
        points.push({ x: inputBufferX, y: y2 });
      }
    }
    
    // Final segment entering the input from the left
    points.push({ x: x2, y: y2 });
    
    return points;
  }
  
  /**
   * Track vertical line positions to avoid overlaps
   * Returns an offset X position if the requested X would overlap
   */
  const verticalLineRegistry = [];
  
  function getOffsetVerticalX(requestedX, minY, maxY) {
    const OFFSET = 8;
    const TOLERANCE = 5; // Consider lines within 5px as overlapping
    
    // Clean up old entries (simple approach: clear all before each render cycle)
    // This is called during rendering, so we'll track for this render pass
    
    // Check for overlapping lines
    for (const existing of verticalLineRegistry) {
      // Check if Y ranges overlap
      const yOverlap = !(maxY < existing.minY || minY > existing.maxY);
      
      if (yOverlap && Math.abs(requestedX - existing.x) < TOLERANCE) {
        // Offset to the right
        return getOffsetVerticalX(requestedX + OFFSET, minY, maxY);
      }
    }
    
    // Register this line
    verticalLineRegistry.push({ x: requestedX, minY, maxY });
    
    return requestedX;
  }
  
  /**
   * Check if a horizontal line segment is clear of obstacles
   */
  function isHorizontalClear(x1, x2, y, obstacles) {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    
    for (const obs of obstacles) {
      if (y >= obs.y1 && y <= obs.y2) {
        if (!(maxX < obs.x1 || minX > obs.x2)) {
          return false;
        }
      }
    }
    return true;
  }
  
  /**
   * Calculate the actual transfer rate for a specific connection
   * based on downstream demand and available output
   */
  /**
   * Calculate rate distribution for all connections from a single output port
   * Uses iterative redistribution algorithm:
   * 1. Split equally among all connections
   * 2. Cap each by demand and belt speed
   * 3. Redistribute freed capacity to others
   * 4. Repeat until all capacity used or no more redistribution possible
   */
  function distributeOutputRate(sourceMachine, fromPortIdx, totalAvailable) {
    const siblingConnections = state.build.connections.filter(
      conn => conn.fromMachineId === sourceMachine.id && 
              String(conn.fromPortIdx) === String(fromPortIdx)
    );
    
    if (siblingConnections.length === 0) return new Map();
    
    const beltSpeed = getConveyorSpeed();
    const distribution = new Map(); // connectionId -> rate
    
    // Build demand info for each connection
    const connectionInfo = siblingConnections.map(conn => {
      const target = state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
      if (!target) {
        return { conn, maxDemand: 0, currentRate: 0, satisfied: true };
      }
      
      const targetMachineData = target.machineId ? getMachineById(target.machineId) : null;
      const isStorage = targetMachineData && targetMachineData.kind === "storage";
      const targetEfficiency = target.efficiency !== undefined ? target.efficiency : 1.0;
      
      let maxDemand = getPortInputDemand(target, conn.toPortIdx) * targetEfficiency;
      
      // Storage and belt speed caps
      if (isStorage) {
        maxDemand = Math.min(maxDemand, beltSpeed);
      }
      maxDemand = Math.min(maxDemand, beltSpeed);
      
      return {
        conn,
        maxDemand,
        currentRate: 0,
        satisfied: false
      };
    });
    
    let remaining = totalAvailable;
    let changed = true;
    const maxIterations = 10;
    let iteration = 0;
    
    // Iterative redistribution
    while (remaining > 0.01 && changed && iteration < maxIterations) {
      changed = false;
      iteration++;
      
      // Find unsatisfied connections
      const unsatisfied = connectionInfo.filter(info => !info.satisfied);
      
      if (unsatisfied.length === 0) break;
      
      // Distribute remaining equally among unsatisfied
      const share = remaining / unsatisfied.length;
      
      unsatisfied.forEach(info => {
        const additionalCapacity = Math.min(share, info.maxDemand - info.currentRate);
        
        if (additionalCapacity > 0.01) {
          info.currentRate += additionalCapacity;
          remaining -= additionalCapacity;
          changed = true;
          
          // Mark as satisfied if at max demand
          if (info.currentRate >= info.maxDemand - 0.01) {
            info.satisfied = true;
          }
        } else {
          info.satisfied = true;
        }
      });
    }
    
    // Build result map
    connectionInfo.forEach(info => {
      distribution.set(info.conn.id, info.currentRate);
    });
    
    return distribution;
  }
  
  function getConnectionRate(connection) {
    // Use cached rate if available and recent
    if (connection.actualRate !== undefined && connection.lastCalculated) {
      return connection.actualRate;
    }
    
    const sourceMachine = state.build.placedMachines.find(pm => pm.id === connection.fromMachineId);
    const targetMachine = state.build.placedMachines.find(pm => pm.id === connection.toMachineId);
    
    if (!sourceMachine || !targetMachine) return 0;
    
    // Apply source machine efficiency to max output
    const sourceEfficiency = sourceMachine.efficiency !== undefined ? sourceMachine.efficiency : 1.0;
    const totalAvailable = getPortOutputRate(sourceMachine, connection.fromPortIdx) * sourceEfficiency;
    
    // Use distribution algorithm
    const distribution = distributeOutputRate(sourceMachine, connection.fromPortIdx, totalAvailable);
    
    return distribution.get(connection.id) || 0;
  }
  
  function renderConnections(svgEl) {
    const svgNS = "http://www.w3.org/2000/svg";
    
    // Clear existing connections from SVG
    svgEl.innerHTML = "";
    
    // Clear vertical line registry for this render cycle
    verticalLineRegistry.length = 0;
    
    // Track label positions to prevent overlaps
    const labelPositions = [];
    
    /**
     * Check if a bounding box overlaps with any existing labels
     * @param {object} bbox - { x, y, width, height }
     * @returns {boolean} True if overlap detected
     */
    function hasOverlap(bbox) {
      return labelPositions.some(existing => {
        return !(bbox.x + bbox.width < existing.x ||
                 bbox.x > existing.x + existing.width ||
                 bbox.y + bbox.height < existing.y ||
                 bbox.y > existing.y + existing.height);
      });
    }
    
    /**
     * Find a position offset that avoids overlaps
     * @param {number} baseX - Base X position
     * @param {number} baseY - Base Y position
     * @param {number} width - Label width
     * @param {number} height - Label height
     * @returns {{ x: number, y: number }} Adjusted position
     */
    function findNonOverlappingPosition(baseX, baseY, width, height) {
      const offsetStep = 25; // Vertical offset per collision
      const maxAttempts = 10;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Alternate between moving up and down
        const direction = attempt % 2 === 0 ? -1 : 1;
        const offset = Math.ceil(attempt / 2) * offsetStep * direction;
        
        const testY = baseY + offset;
        const testBbox = {
          x: baseX - width / 2,
          y: testY - height / 2,
          width,
          height
        };
        
        if (!hasOverlap(testBbox)) {
          return { x: baseX, y: testY };
        }
      }
      
      // If all attempts fail, return original position (rare edge case)
      return { x: baseX, y: baseY };
    }
    
    // Render existing connections
    state.build.connections.forEach(conn => {
      const fromMachine = document.querySelector(`[data-placed-machine="${conn.fromMachineId}"]`);
      const toMachine = document.querySelector(`[data-placed-machine="${conn.toMachineId}"]`);
      
      if (!fromMachine || !toMachine) return;
      
      const fromPort = fromMachine.querySelector(`[data-output-port="${conn.fromPortIdx}"]`);
      const toPort = toMachine.querySelector(`[data-input-port="${conn.toPortIdx}"]`);
      
      if (!fromPort || !toPort) return;
      
      // Get machine data for world coordinates
      const fromMachineData = state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
      const toMachineData = state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
      
      if (!fromMachineData || !toMachineData) return;
      
      // Calculate port positions in world space using DOM element positions (not getBoundingClientRect)
      // This avoids issues with the container transform
      
      // Helper to get element position relative to its positioned parent
      function getRelativePosition(element, parent) {
        let x = 0;
        let y = 0;
        let current = element;
        
        while (current && current !== parent) {
          x += current.offsetLeft || 0;
          y += current.offsetTop || 0;
          current = current.offsetParent;
          if (current === parent) break;
        }
        
        return { x, y };
      }
      
      // Get port positions relative to machine card
      const fromPortPos = getRelativePosition(fromPort, fromMachine);
      const toPortPos = getRelativePosition(toPort, toMachine);
      
      // Output port: right edge, vertical center
      const fromPortOffsetX = fromPortPos.x + fromPort.offsetWidth;
      const fromPortOffsetY = fromPortPos.y + (fromPort.offsetHeight / 2);
      
      // Input port: left edge, vertical center
      const toPortOffsetX = toPortPos.x;
      const toPortOffsetY = toPortPos.y + (toPort.offsetHeight / 2);
      
      // World coordinates for connection endpoints
      const x1 = fromMachineData.x + fromPortOffsetX;
      const y1 = fromMachineData.y + fromPortOffsetY;
      const x2 = toMachineData.x + toPortOffsetX;
      const y2 = toMachineData.y + toPortOffsetY;
      
      // Card edges for midpoint calculation (using DOM element width, not transformed)
      const fromCardRight = fromMachineData.x + fromMachine.offsetWidth;
      const toCardLeft = toMachineData.x;
      
      // Determine if this is a loopback connection (output right of input)
      const isLoopback = x1 > x2;
      
      // For loopback, keep target as obstacle to route around it; otherwise exclude both
      const excludeIds = isLoopback ? [conn.fromMachineId] : [conn.fromMachineId, conn.toMachineId];
      const obstacles = getObstacles(excludeIds);
      
      const path = findPath(x1, y1, x2, y2, obstacles, fromCardRight, toCardLeft);
      
      // Create polyline from path points
      const points = path.map(p => `${p.x},${p.y}`).join(" ");
      const polyline = document.createElementNS(svgNS, "polyline");
      polyline.setAttribute("points", points);
      polyline.setAttribute("fill", "none");
      polyline.setAttribute("stroke-dasharray", "5,5");
      polyline.setAttribute("data-connection-id", conn.id);
      polyline.style.cursor = "pointer";
      polyline.style.pointerEvents = "auto"; // Enable clicks on polyline
      polyline.style.strokeLinejoin = "round"; // Smoother corners
      
      // Make it easier to click by adding invisible wider stroke
      polyline.setAttribute("stroke-width", "10");
      
      // Create visible stroke on top
      const visiblePolyline = document.createElementNS(svgNS, "polyline");
      visiblePolyline.setAttribute("points", points);
      visiblePolyline.setAttribute("fill", "none");
      visiblePolyline.setAttribute("stroke-dasharray", "5,5");
      visiblePolyline.style.pointerEvents = "none";
      visiblePolyline.style.strokeLinejoin = "round";
      
      // Check if connection is insufficient
      const sourcePlacedMachine = state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
      const targetPlacedMachine = state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
      const connectionRate = getConnectionRate(conn);
      const targetDemand = targetPlacedMachine ? getPortInputDemand(targetPlacedMachine, conn.toPortIdx) : 0;
      
      // Check if insufficient: get ALL connections to this same input port
      // IMPORTANT: Storage machines don't have "demand" - their input "demand" is just a capacity cap
      // so we should never mark storage connections as insufficient
      let isInsufficient = false;
      if (targetDemand > 0 && targetPlacedMachine) {
        const targetMachineData = getMachineById(targetPlacedMachine.machineId);
        const isTargetStorage = targetMachineData && targetMachineData.kind === "storage";
        
        // Only check insufficiency for non-storage machines
        if (!isTargetStorage) {
          const allIncomingToPort = state.build.connections.filter(
            c => c.toMachineId === conn.toMachineId && c.toPortIdx === conn.toPortIdx
          );
          const totalIncoming = allIncomingToPort.reduce((sum, c) => sum + getConnectionRate(c), 0);
          isInsufficient = totalIncoming < targetDemand - 0.01;
        }
      }
      
      // Style based on selection state and sufficiency
      const isSelected = state.build.selectedConnection === conn.id;
      polyline.setAttribute("stroke", "transparent");
      
      let lineColor = "#5aa2ff"; // Default blue
      if (isSelected) {
        lineColor = "#45d483"; // Green when selected
      } else if (isInsufficient) {
        lineColor = "#ff5a6a"; // Red when insufficient
      }
      
      visiblePolyline.setAttribute("stroke", lineColor);
      visiblePolyline.setAttribute("stroke-width", isSelected ? "3" : "2");
      
      svgEl.appendChild(polyline);
      svgEl.appendChild(visiblePolyline);
      
      // Add connection info label (material, rate, direction)
      if (sourcePlacedMachine) {
        const materialId = getMaterialIdFromPort(sourcePlacedMachine, conn.fromPortIdx, "output");
        const material = materialId ? getMaterialById(materialId) : null;
        const rate = connectionRate; // Use per-connection rate
        
        if (material) {
          // Calculate exact midpoint based on path distance
          let totalDistance = 0;
          const segmentDistances = [];
          for (let i = 1; i < path.length; i++) {
            const dx = path[i].x - path[i - 1].x;
            const dy = path[i].y - path[i - 1].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            segmentDistances.push(dist);
            totalDistance += dist;
          }
          
          const halfDistance = totalDistance / 2;
          let accumulatedDist = 0;
          let labelX = path[0].x;
          let labelY = path[0].y;
          let segmentIdx = 0;
          
          for (let i = 0; i < segmentDistances.length; i++) {
            if (accumulatedDist + segmentDistances[i] >= halfDistance) {
              // Midpoint is in this segment
              const remainingDist = halfDistance - accumulatedDist;
              const t = remainingDist / segmentDistances[i];
              labelX = path[i].x + t * (path[i + 1].x - path[i].x);
              labelY = path[i].y + t * (path[i + 1].y - path[i].y);
              segmentIdx = i;
              break;
            }
            accumulatedDist += segmentDistances[i];
          }
          
          // Determine direction arrow based on segment at midpoint
          let arrow = "→";
          if (segmentIdx < path.length - 1) {
            const dx = path[segmentIdx + 1].x - path[segmentIdx].x;
            const dy = path[segmentIdx + 1].y - path[segmentIdx].y;
            
            if (Math.abs(dx) > Math.abs(dy)) {
              arrow = dx > 0 ? "→" : "←";
            } else {
              arrow = dy > 0 ? "↓" : "↑";
            }
          }
          
          // Calculate conveyors needed
          const beltSpeed = getConveyorSpeed();
          const conveyorsNeeded = Math.ceil(rate / beltSpeed);
          
          // Build label text
          let labelText = `${material.name} ${arrow} ${rate.toFixed(2)}/min (${conveyorsNeeded}x)`;
          if (isInsufficient && targetDemand > 0) {
            labelText = `⚠ ${labelText} (need ${targetDemand.toFixed(2)})`;
          }
          
          // Calculate label dimensions
          const textWidth = labelText.length * 6; // Rough estimate
          const padding = 6;
          const labelWidth = textWidth + padding * 2;
          const labelHeight = 20;
          
          // Find non-overlapping position
          const adjustedPos = findNonOverlappingPosition(labelX, labelY, labelWidth, labelHeight);
          
          // Create a group for the label at adjusted position
          const labelGroup = document.createElementNS(svgNS, "g");
          labelGroup.setAttribute("transform", `translate(${adjustedPos.x}, ${adjustedPos.y})`);
          
          // Background rectangle
          const rect = document.createElementNS(svgNS, "rect");
          rect.setAttribute("x", -labelWidth / 2);
          rect.setAttribute("y", -labelHeight / 2);
          rect.setAttribute("width", labelWidth);
          rect.setAttribute("height", labelHeight);
          rect.setAttribute("fill", "#151923");
          rect.setAttribute("stroke", lineColor);
          rect.setAttribute("stroke-width", "1");
          rect.setAttribute("rx", "4");
          rect.style.pointerEvents = "none";
          
          // Text
          const text = document.createElementNS(svgNS, "text");
          text.setAttribute("x", 0);
          text.setAttribute("y", 4);
          text.setAttribute("text-anchor", "middle");
          text.setAttribute("fill", "#e9eef7");
          text.setAttribute("font-size", "11");
          text.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
          text.style.pointerEvents = "none";
          text.textContent = labelText;
          
          labelGroup.appendChild(rect);
          labelGroup.appendChild(text);
          svgEl.appendChild(labelGroup);
          
          // Store this label's position to prevent future overlaps
          labelPositions.push({
            x: adjustedPos.x - labelWidth / 2,
            y: adjustedPos.y - labelHeight / 2,
            width: labelWidth,
            height: labelHeight
          });
        }
      }
    });
    
    // Render preview line if dragging connection
    if (state.ui.dragState && state.ui.dragState.type === "connection" && state.ui.dragState.currentX) {
      const x1 = state.ui.dragState.startX;
      const y1 = state.ui.dragState.startY;
      const x2 = state.ui.dragState.currentX;
      const y2 = state.ui.dragState.currentY;
      
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.setAttribute("stroke", "#5aa2ff");
      line.setAttribute("stroke-width", "2");
      line.setAttribute("opacity", "0.5");
      line.setAttribute("stroke-dasharray", "5,5");
      
      svgEl.appendChild(line);
    }
  }
  
  function addMachineToCanvas(machineId) {
    const machine = getMachineById(machineId);
    if (!machine) return;
    
    const id = makeId("pm");
    
    // Place new machines at camera position with a stagger offset
    const offset = state.build.placedMachines.length * 50;
    const placedMachine = {
      id,
      type: "machine",
      machineId,
      recipeId: null,
      count: 1,
      x: state.build.camera.x + offset,
      y: state.build.camera.y + offset,
    };
    
    // Initialize storage-specific fields
    if (machine.kind === "storage") {
      placedMachine.storageSlots = machine.storageSlots;
      placedMachine.inventories = [];
      placedMachine.manualInventories = [];
    }
    
    // Initialize heating device-specific fields
    if (machine.kind === "heating_device") {
      placedMachine.toppers = []; // Array of { machineId, recipeId, count }
      placedMachine.previewFuelId = null; // For showing fuel requirements when not connected
    }
    
    state.build.placedMachines.push(placedMachine);
    saveBuild();
    renderCanvas();
    setStatus(`Added ${machine.name} to canvas.`);
  }
  
  function addBlankMachineToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "machine",
      machineId: null, // No machine selected yet
      recipeId: null,
      count: 1,
      x: x !== undefined ? x : state.build.camera.x,
      y: y !== undefined ? y : state.build.camera.y,
    };
    
    state.build.placedMachines.push(placedMachine);
    saveBuild();
    renderCanvas();
    setStatus("Machine card added. Select a machine type.");
  }
  
  function addStorageToCanvas(x, y, machineId) {
    const machine = getMachineById(machineId);
    if (!machine || machine.kind !== "storage") {
      setStatus("Invalid storage machine.", "error");
      return;
    }
    
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "machine",
      machineId: machineId,
      recipeId: null,
      count: 1,
      storageSlots: machine.storageSlots,
      inventories: [],
      manualInventories: [],
      x: x || 100,
      y: y || 100,
    };
    
    state.build.placedMachines.push(placedMachine);
    saveBuild();
    renderCanvas();
    setStatus(`${machine.name} added to canvas.`);
  }
  
  function addPurchasingPortalToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "purchasing_portal",
      machineId: null,
      recipeId: null,
      count: 1,
      materialId: null, // Material to purchase
      x: x !== undefined ? x : state.build.camera.x,
      y: y !== undefined ? y : state.build.camera.y,
    };
    
    state.build.placedMachines.push(placedMachine);
    saveBuild();
    renderCanvas();
    setStatus("Purchasing Portal added to canvas.");
  }
  
  function addFuelSourceToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "fuel_source",
      machineId: null,
      recipeId: null,
      count: 1,
      fuelId: null, // Fuel material
      x: x !== undefined ? x : state.build.camera.x,
      y: y !== undefined ? y : state.build.camera.y,
    };
    
    state.build.placedMachines.push(placedMachine);
    saveBuild();
    renderCanvas();
    setStatus("Fuel Source added to canvas.");
  }
  
  function addNurseryToCanvas(x, y) {
    const id = makeId("pm");
    const placedMachine = {
      id,
      type: "nursery",
      machineId: null,
      recipeId: null,
      count: 1,
      plantId: null, // Plant material
      fertilizerId: null, // Fertilizer material (for preview when not connected)
      x: x !== undefined ? x : state.build.camera.x,
      y: y !== undefined ? y : state.build.camera.y,
    };
    
    state.build.placedMachines.push(placedMachine);
    saveBuild();
    renderCanvas();
    setStatus("Nursery added to canvas.");
  }
  
  function updatePlacedMachineType(placedMachineId, machineId) {
    const pm = state.build.placedMachines.find(m => m.id === placedMachineId);
    if (!pm) return;
    
    const machine = getMachineById(machineId);
    
    // Update machine type
    pm.machineId = machineId;
    pm.recipeId = null; // Reset recipe when changing machine type
    
    // Initialize kind-specific fields
    if (machine && machine.kind === "storage") {
      pm.storageSlots = machine.storageSlots;
      pm.inventories = [];
      pm.manualInventories = [];
      delete pm.toppers;
      delete pm.previewFuelId;
    } else if (machine && machine.kind === "heating_device") {
      pm.toppers = [];
      pm.previewFuelId = null;
      delete pm.storageSlots;
      delete pm.inventories;
      delete pm.manualInventories;
    } else {
      // Clear kind-specific fields for standard machines
      delete pm.storageSlots;
      delete pm.inventories;
      delete pm.manualInventories;
      delete pm.toppers;
      delete pm.previewFuelId;
    }
    
    // Remove any existing connections
    state.build.connections = state.build.connections.filter(
      conn => conn.fromMachineId !== placedMachineId && conn.toMachineId !== placedMachineId
    );
    
    saveBuild();
    renderCanvas(true); // Force recreation since machine content changed
    
    if (machine) {
      setStatus(`Machine type changed to ${machine.name}.`);
    }
  }
  
  function selectPlacedMachine(machineId) {
    state.build.selectedMachines = [machineId];
    state.build.selectedConnection = null; // Deselect any selected connection
    updateSelectionClasses();
    renderCanvas(); // Re-render for connection selection state
  }
  
  function selectConnection(connectionId) {
    state.build.selectedConnection = connectionId;
    state.build.selectedMachines = []; // Deselect any selected machines
    updateSelectionClasses();
    renderCanvas(); // Re-render for connection selection state
  }
  
  function clonePlacedMachine(machineId) {
    const original = state.build.placedMachines.find(pm => pm.id === machineId);
    if (!original) return;
    
    // Create a new ID
    const newId = makeId("pm");
    
    // Deep clone the machine (excluding connections)
    const clone = {
      ...original,
      id: newId,
      x: original.x + 50, // Offset position
      y: original.y + 50,
    };
    
    // Deep clone toppers for heating devices
    if (clone.toppers && Array.isArray(clone.toppers)) {
      clone.toppers = clone.toppers.map(topper => ({
        ...topper,
        machineId: topper.machineId,
        recipeId: topper.recipeId,
        count: topper.count
      }));
    }
    
    // Deep clone manual inventories for storage
    if (clone.manualInventories && Array.isArray(clone.manualInventories)) {
      clone.manualInventories = clone.manualInventories.map(inv => ({
        ...inv,
        materialId: inv.materialId,
        slotsAllocated: inv.slotsAllocated,
        currentAmount: inv.currentAmount
      }));
    }
    
    // Clear calculated inventories (will be recalculated)
    if (clone.inventories) {
      delete clone.inventories;
    }
    
    state.build.placedMachines.push(clone);
    saveBuild();
    renderCanvas();
    setStatus(`Machine cloned successfully.`);
  }
  
  function centerAllMachinesAtOrigin() {
    if (state.build.placedMachines.length === 0) {
      setStatus("No machines to center.", "error");
      return;
    }
    
    // Calculate bounding box of all machines
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    
    state.build.placedMachines.forEach(pm => {
      const machineEl = document.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!machineEl) return;
      
      const width = machineEl.offsetWidth;
      const height = machineEl.offsetHeight;
      
      minX = Math.min(minX, pm.x);
      minY = Math.min(minY, pm.y);
      maxX = Math.max(maxX, pm.x + width);
      maxY = Math.max(maxY, pm.y + height);
    });
    
    // Calculate center of bounding box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    // Calculate offset to move center to origin
    const offsetX = -centerX;
    const offsetY = -centerY;
    
    // Apply offset to all machines
    state.build.placedMachines.forEach(pm => {
      pm.x += offsetX;
      pm.y += offsetY;
    });
    
    saveBuild();
    renderCanvas(true); // Force recreate to update positions
    setStatus("All machines centered at origin.");
  }
  
  function deleteSelectedMachines() {
    if (state.build.selectedMachines.length === 0) return;
    
    const count = state.build.selectedMachines.length;
    const confirmMsg = count === 1 
      ? "Remove this machine and all its connections from the canvas?"
      : `Remove ${count} machines and all their connections from the canvas?`;
    
    if (!confirm(confirmMsg)) return;
    
    // Remove all selected machines
    state.build.placedMachines = state.build.placedMachines.filter(
      pm => !state.build.selectedMachines.includes(pm.id)
    );
    
    // Remove all connections to/from selected machines
    state.build.connections = state.build.connections.filter(conn => 
      !state.build.selectedMachines.includes(conn.fromMachineId) && 
      !state.build.selectedMachines.includes(conn.toMachineId)
    );
    
    state.build.selectedMachines = [];
    saveBuild();
    renderCanvas();
    setStatus(`${count} machine${count > 1 ? 's' : ''} removed from canvas.`);
  }
  
  function deletePlacedMachine(machineId) {
    if (!confirm("Remove this machine and all its connections from the canvas?")) return;
    
    state.build.placedMachines = state.build.placedMachines.filter(pm => pm.id !== machineId);
    state.build.connections = state.build.connections.filter(
      conn => conn.fromMachineId !== machineId && conn.toMachineId !== machineId
    );
    
    // Remove from selection if selected
    state.build.selectedMachines = state.build.selectedMachines.filter(id => id !== machineId);
    
    saveBuild();
    renderCanvas();
    setStatus("Machine removed from canvas.");
  }
  
  function deleteConnection(connectionId) {
    const conn = state.build.connections.find(c => c.id === connectionId);
    if (!conn) return;
    
    if (!confirm("Remove this connection?")) return;
    
    state.build.connections = state.build.connections.filter(c => c.id !== connectionId);
    
    if (state.build.selectedConnection === connectionId) {
      state.build.selectedConnection = null;
    }
    
    saveBuild();
    renderCanvas();
    setStatus("Connection removed.");
  }
  
  function updatePlacedMachineRecipe(machineId, recipeId) {
    const pm = state.build.placedMachines.find(m => m.id === machineId);
    if (!pm) return;
    
    pm.recipeId = recipeId || null;
    
    // Remove connections that are no longer valid (only for numeric port indices)
    const recipe = recipeId ? getRecipeById(recipeId) : null;
    if (recipe) {
      state.build.connections = state.build.connections.filter(conn => {
        // Only validate numeric port indices (standard machines)
        const fromPortIsNumeric = typeof conn.fromPortIdx === 'number' || !isNaN(Number(conn.fromPortIdx));
        const toPortIsNumeric = typeof conn.toPortIdx === 'number' || !isNaN(Number(conn.toPortIdx));
        
        if (conn.fromMachineId === machineId && fromPortIsNumeric && Number(conn.fromPortIdx) >= recipe.outputs.length) return false;
        if (conn.toMachineId === machineId && toPortIsNumeric && Number(conn.toPortIdx) >= recipe.inputs.length) return false;
        return true;
      });
    }
    
    saveBuild();
    renderCanvas(true); // Force recreation since recipe changed
  }
  
  // ---------- Production Summary ----------
  
  function renderProductionSummary() {
    const summary = $("#productionSummary");
    if (!summary) return;
    
    const netProduction = getNetProduction();
    const sources = findSourceMachines();
    const sinks = findSinkMachines();
    
    let html = "";
    
    // Source machines (no inputs)
    if (sources.length > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">Source Machines (no inputs)</div>`;
      sources.forEach(pm => {
        const machine = pm.machineId ? getMachineById(pm.machineId) : null;
        let name = "Unknown";
        if (pm.type === "purchasing_portal") {
          const mat = pm.materialId ? getMaterialById(pm.materialId) : null;
          name = `Purchasing Portal${mat ? ` (${mat.name})` : ''}`;
        } else if (pm.type === "fuel_source") {
          const fuel = pm.fuelId ? getMaterialById(pm.fuelId) : null;
          name = `Fuel Source${fuel ? ` (${fuel.name})` : ''}`;
        } else if (pm.type === "nursery") {
          const plant = pm.plantId ? getMaterialById(pm.plantId) : null;
          name = `Nursery${plant ? ` (${plant.name})` : ''}`;
        } else if (machine) {
          name = machine.kind === "storage" ? `${machine.name} (Storage)` : machine.name;
        }
        html += `<div class="productionItem">• ${escapeHtml(name)} ${pm.count > 1 ? `(×${pm.count})` : ''}</div>`;
      });
      html += `</div>`;
    }
    
    // Sink machines (no outputs)
    if (sinks.length > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">Sink Machines (no outputs)</div>`;
      sinks.forEach(pm => {
        const machine = pm.machineId ? getMachineById(pm.machineId) : null;
        let name = "Unknown";
        if (pm.type === "purchasing_portal") name = "Purchasing Portal";
        else if (pm.type === "fuel_source") name = "Fuel Source";
        else if (pm.type === "nursery") name = "Nursery";
        else if (machine) {
          name = machine.kind === "storage" ? `${machine.name} (Storage)` : machine.name;
        }
        html += `<div class="productionItem">• ${escapeHtml(name)} ${pm.count > 1 ? `(×${pm.count})` : ''}</div>`;
      });
      html += `</div>`;
    }
    
    // Net production/consumption (only show non-zero values)
    html += `<div class="productionSection">
      <div class="productionSection__title">Net Production/Consumption</div>`;
    
    if (netProduction.size === 0) {
      html += `<div class="hint">No production calculated. Add machines and recipes.</div>`;
    } else {
      // Filter out materials with net rate close to 0 (within tolerance)
      const entries = Array.from(netProduction.entries())
        .filter(([materialId, rate]) => Math.abs(rate) > 0.01)
        .sort((a, b) => b[1] - a[1]);
      
      if (entries.length === 0) {
        html += `<div class="hint">All materials are balanced (net zero production/consumption).</div>`;
      } else {
        entries.forEach(([materialId, rate]) => {
          const material = getMaterialById(materialId);
          const name = material ? material.name : "(unknown)";
          const rateFormatted = rate.toFixed(1);
          const color = rate > 0 ? "var(--ok)" : "var(--danger)";
          const sign = rate > 0 ? "+" : "";
          html += `<div class="productionItem" style="color: ${color};">
            ${escapeHtml(name)}: ${sign}${rateFormatted}/min
          </div>`;
        });
      }
    }
    html += `</div>`;
    
    // Storage fill times (only show storages with net positive rates)
    const storages = state.build.placedMachines.filter(pm => {
      if (!pm.machineId) return false;
      const machine = getMachineById(pm.machineId);
      return machine && machine.kind === "storage";
    });
    
    if (storages.length > 0) {
      html += `<div class="productionSection">
        <div class="productionSection__title">Storage Fill Times</div>`;
      
      let hasAnyFillingStorage = false;
      storages.forEach(pm => {
        const inventories = calculateStorageInventory(pm);
        const machine = getMachineById(pm.machineId);
        
        inventories.forEach(inv => {
          // Only show materials with positive net rate (filling)
          if (inv.netRate > 0.01 && inv.timeToFillMinutes !== null && isFinite(inv.timeToFillMinutes)) {
            hasAnyFillingStorage = true;
            const timeStr = formatTimeMinutes(inv.timeToFillMinutes);
            html += `<div class="productionItem">
              <strong>${escapeHtml(machine.name)}</strong> - ${escapeHtml(inv.materialName)}: 
              <span style="color: var(--ok);">Fills in ${timeStr}</span> 
              <span style="color: var(--muted); font-size: 10px;">@ ${inv.inputRate.toFixed(1)}/min</span>
            </div>`;
          }
        });
      });
      
      if (!hasAnyFillingStorage) {
        html += `<div class="hint">No storages are currently filling. Connect inputs to storages to see fill times.</div>`;
      }
      
      html += `</div>`;
    }
    
    summary.innerHTML = html;
  }
  
  // ---------- Skills Dialog ----------
  
  function openJumpToCoordinatesDialog() {
    const dialog = $("#jumpToCoordinatesDialog");
    if (!dialog) return;
    
    // Pre-fill with current camera position
    const xInput = $("#jumpToX");
    const yInput = $("#jumpToY");
    if (xInput) xInput.value = Math.round(state.build.camera.x);
    if (yInput) yInput.value = Math.round(state.build.camera.y);
    
    dialog.classList.remove("hidden");
    
    // Focus on X input
    setTimeout(() => xInput?.select(), 100);
    
    // Handle Enter key to jump
    const handleKeyPress = (e) => {
      if (e.key === "Enter") {
        jumpToCoordinates();
        dialog.removeEventListener("keypress", handleKeyPress);
      } else if (e.key === "Escape") {
        closeDialog();
        dialog.removeEventListener("keypress", handleKeyPress);
      }
    };
    dialog.addEventListener("keypress", handleKeyPress);
    
    // Close on overlay click
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) {
      overlay.onclick = closeDialog;
    }
  }
  
  function jumpToCoordinates() {
    const xInput = $("#jumpToX");
    const yInput = $("#jumpToY");
    
    if (!xInput || !yInput) return;
    
    const x = parseFloat(xInput.value) || 0;
    const y = parseFloat(yInput.value) || 0;
    
    // Move camera to specified coordinates
    state.build.camera.x = x;
    state.build.camera.y = y;
    
    saveBuild();
    updateCameraTransform();
    closeDialog();
    setStatus(`Jumped to (${Math.round(x)}, ${Math.round(y)})`);
  }
  
  // ---------- Sidebar Management ----------
  
  function toggleDatabaseSidebar() {
    const wasOpen = state.ui.sidebars.database;
    
    // Clear any pending production summary updates when closing production sidebar
    if (state.ui.productionSummaryDebounceTimer) {
      clearTimeout(state.ui.productionSummaryDebounceTimer);
      state.ui.productionSummaryDebounceTimer = null;
    }
    
    // Close left sidebars (only one left panel can be open at a time)
    state.ui.sidebars.database = false;
    state.ui.sidebars.blueprints = false;
    $("#databaseSidebar")?.classList.add("hidden");
    $("#blueprintsSidebar")?.classList.add("hidden");
    
    // If it wasn't open, open it now
    if (!wasOpen) {
      state.ui.sidebars.database = true;
      $("#databaseSidebar")?.classList.remove("hidden");
    }
    
    // Update grid layout
    updateLayoutGridColumns();
    
    // Save UI preferences
    saveUIPrefs();
    
    // Update camera transform after layout change (canvas dimensions may have changed)
    setTimeout(() => updateCameraTransform(), 0);
  }
  
  function toggleBlueprintsSidebar() {
    const wasOpen = state.ui.sidebars.blueprints;
    
    // Clear any pending production summary updates when closing production sidebar
    if (state.ui.productionSummaryDebounceTimer) {
      clearTimeout(state.ui.productionSummaryDebounceTimer);
      state.ui.productionSummaryDebounceTimer = null;
    }
    
    // Close left sidebars (only one left panel can be open at a time)
    state.ui.sidebars.database = false;
    state.ui.sidebars.blueprints = false;
    $("#databaseSidebar")?.classList.add("hidden");
    $("#blueprintsSidebar")?.classList.add("hidden");
    
    // If it wasn't open, open it now
    if (!wasOpen) {
      state.ui.sidebars.blueprints = true;
      $("#blueprintsSidebar")?.classList.remove("hidden");
    }
    
    // Update grid layout
    updateLayoutGridColumns();
    
    // Save UI preferences
    saveUIPrefs();
    
    // Update camera transform after layout change (canvas dimensions may have changed)
    setTimeout(() => updateCameraTransform(), 0);
  }
  
  /**
   * Update layout grid columns based on which sidebars are open
   */
  function updateLayoutGridColumns() {
    const layout = $(".layout");
    if (!layout) return;
    
    const leftOpen = state.ui.sidebars.database || state.ui.sidebars.blueprints;
    const rightOpen = state.ui.sidebars.production;
    
    if (leftOpen && rightOpen) {
      // Both sides open: left panel, canvas, right panel
      layout.style.gridTemplateColumns = "auto 1fr auto";
    } else if (leftOpen && !rightOpen) {
      // Only left panel open: left panel, canvas
      layout.style.gridTemplateColumns = "auto 1fr";
    } else if (!leftOpen && rightOpen) {
      // Only right panel open: canvas, right panel
      layout.style.gridTemplateColumns = "1fr auto";
    } else {
      // No panels open: just canvas
      layout.style.gridTemplateColumns = "1fr";
    }
  }
  
  /**
   * Debounced production summary recalculation
   * Schedules a recalculation after 500ms of inactivity
   * Only recalculates if the production sidebar is open
   */
  function scheduleProductionSummaryUpdate() {
    // Only schedule if production sidebar is open
    if (!state.ui.sidebars.production) return;
    
    // Clear existing timer
    if (state.ui.productionSummaryDebounceTimer) {
      clearTimeout(state.ui.productionSummaryDebounceTimer);
    }
    
    // Schedule new calculation
    state.ui.productionSummaryDebounceTimer = setTimeout(() => {
      if (state.ui.sidebars.production) {
        renderProductionSummary();
      }
    }, 500); // 500ms debounce delay
  }
  
  function toggleProductionSidebar() {
    const wasOpen = state.ui.sidebars.production;
    
    // Clear any pending production summary updates
    if (state.ui.productionSummaryDebounceTimer) {
      clearTimeout(state.ui.productionSummaryDebounceTimer);
      state.ui.productionSummaryDebounceTimer = null;
    }
    
    // Toggle only production sidebar (can coexist with left panels)
    state.ui.sidebars.production = !wasOpen;
    
    if (state.ui.sidebars.production) {
      $("#productionSidebar")?.classList.remove("hidden");
      // Render production summary immediately when opening
      renderProductionSummary();
    } else {
      $("#productionSidebar")?.classList.add("hidden");
    }
    
    // Update grid layout
    updateLayoutGridColumns();
    
    // Save UI preferences
    saveUIPrefs();
    
    // Update camera transform after layout change (canvas dimensions may have changed)
    setTimeout(() => updateCameraTransform(), 0);
  }
  
  // ---------- Blueprint Management ----------
  
  function updateCreateBlueprintButton() {
    const btn = $("#createBlueprintBtn");
    if (!btn) return;
    
    // Enable button only when machines are selected
    if (state.build.selectedMachines.length > 0) {
      btn.disabled = false;
    } else {
      btn.disabled = true;
    }
  }
  
  function openCreateBlueprintDialog() {
    if (state.build.selectedMachines.length === 0) {
      setStatus("Please select one or more machines to create a blueprint.", "warning");
      return;
    }
    
    const dialog = $("#createBlueprintDialog");
    if (!dialog) return;
    
    // Calculate blueprint analysis (blueprints can now contain other blueprints - nesting allowed)
    let analysis;
    try {
      console.log("Starting blueprint analysis...");
      analysis = analyzeBlueprintMachines(state.build.selectedMachines);
      console.log("Analysis complete:", analysis);
    } catch (err) {
      console.error("Error analyzing blueprint:", err);
      setStatus("Error analyzing blueprint: " + err.message, "error");
      return;
    }
    
    // Populate included machines list
    const includedEl = $("#blueprintIncludedMachines");
    if (includedEl) {
      includedEl.innerHTML = analysis.machines.map(pm => {
        let machineName = "Unknown";
        
        // Handle special machine types
        if (pm.type === "purchasing_portal") {
          machineName = "Purchasing Portal";
        } else if (pm.type === "fuel_source") {
          machineName = "Fuel Source";
        } else if (pm.type === "nursery") {
          machineName = "Nursery";
        } else if (pm.type === "blueprint") {
          machineName = pm.blueprintData?.name || "Blueprint";
        } else {
          const machine = getMachineById(pm.machineId);
          machineName = machine ? machine.name : "Unknown";
        }
        
        return `<div style="padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.04);">${machineName} ${pm.count > 1 ? `(×${pm.count})` : ''}</div>`;
      }).join('');
    }
    
    // Populate inputs
    const inputsEl = $("#blueprintInputs");
    if (inputsEl) {
      if (analysis.inputs.length === 0) {
        inputsEl.innerHTML = '<em>No external inputs required</em>';
      } else {
        inputsEl.innerHTML = analysis.inputs.map(input => {
          const material = getMaterialById(input.materialId);
          const materialName = material ? material.name : "Unknown";
          return `<div>• ${materialName}: ${input.rate.toFixed(2)}/min</div>`;
        }).join('');
      }
    }
    
    // Populate outputs
    const outputsEl = $("#blueprintOutputs");
    if (outputsEl) {
      if (analysis.outputs.length === 0) {
        outputsEl.innerHTML = '<em>No external outputs</em>';
      } else {
        outputsEl.innerHTML = analysis.outputs.map(output => {
          const material = getMaterialById(output.materialId);
          const materialName = material ? material.name : "Unknown";
          return `<div>• ${materialName}: ${output.rate.toFixed(2)}/min</div>`;
        }).join('');
      }
    }
    
    // Clear form inputs
    const nameInput = $("#blueprintName");
    const descInput = $("#blueprintDescription");
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
    
    dialog.classList.remove("hidden");
    if (nameInput) nameInput.focus();
    
    // Close on overlay click
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) {
      overlay.onclick = closeDialog;
    }
  }
  
  function analyzeBlueprintMachines(selectedMachineIds) {
    console.log("=== Blueprint Analysis Start ===");
    console.log("Selected machine IDs:", selectedMachineIds);
    
    const selectedSet = new Set(selectedMachineIds);
    const machines = state.build.placedMachines.filter(pm => selectedSet.has(pm.id));
    console.log("Machines to analyze:", machines.length);
    
    // Calculate what each machine produces/consumes
    const productionRates = calculateProductionFlow(selectedMachineIds);
    
    // Track net flows by material
    const inputsMap = new Map(); // Materials flowing INTO the blueprint from outside
    const outputsMap = new Map(); // Materials flowing OUT of the blueprint to outside
    
    // Check all connections to find boundary crossings
    state.build.connections.forEach(conn => {
      const fromInside = selectedSet.has(conn.fromMachineId);
      const toInside = selectedSet.has(conn.toMachineId);
      
      // Skip internal connections
      if (fromInside && toInside) return;
      
      const rate = getConnectionRate(conn);
      if (!rate) return;
      
      const sourceMachine = state.build.placedMachines.find(m => m.id === conn.fromMachineId);
      if (!sourceMachine) return;
      
      const materialId = getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
      if (!materialId) return;
      
      if (!fromInside && toInside) {
        // Connection from outside TO inside = input
        inputsMap.set(materialId, (inputsMap.get(materialId) || 0) + rate);
        console.log(`Input: ${getMaterialById(materialId)?.name} @ ${rate}/min from outside`);
      } else if (fromInside && !toInside) {
        // Connection from inside TO outside = output
        outputsMap.set(materialId, (outputsMap.get(materialId) || 0) + rate);
        console.log(`Output: ${getMaterialById(materialId)?.name} @ ${rate}/min to outside`);
      }
    });
    
    // Also check for unconnected ports (these are also external inputs/outputs)
    machines.forEach(pm => {
      const rates = productionRates.get(pm.id);
      if (!rates) return;
      
      // Check inputs without connections
      rates.inputs.forEach(inp => {
        if (!inp.materialId) return;
        
        // Find incoming connections for this input
        const incomingConnections = state.build.connections.filter(conn => 
          conn.toMachineId === pm.id
        );
        
        // Check if this specific material is being supplied
        let suppliedRate = 0;
        incomingConnections.forEach(conn => {
          const sourceMachine = state.build.placedMachines.find(m => m.id === conn.fromMachineId);
          if (!sourceMachine) return;
          const connMaterialId = getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          if (connMaterialId === inp.materialId) {
            suppliedRate += getConnectionRate(conn);
          }
        });
        
        // If not fully supplied, the deficit is an external input
        if (suppliedRate < inp.rate - 0.01) {
          const deficit = inp.rate - suppliedRate;
          inputsMap.set(inp.materialId, (inputsMap.get(inp.materialId) || 0) + deficit);
          console.log(`Unconnected input: ${getMaterialById(inp.materialId)?.name} @ ${deficit}/min (deficit)`);
        }
      });
      
      // Check outputs without connections
      // Skip this check for infinite source machines (purchasing_portal, fuel_source)
      // They only produce what's needed downstream, excess capacity isn't an "output"
      const isInfiniteSource = pm.type === "purchasing_portal" || pm.type === "fuel_source";
      
      if (!isInfiniteSource) {
        rates.outputs.forEach(out => {
          if (!out.materialId) return;
          
          // Find outgoing connections for this output
          const outgoingConnections = state.build.connections.filter(conn => 
            conn.fromMachineId === pm.id
          );
          
          // Calculate how much is consumed
          let consumedRate = 0;
          outgoingConnections.forEach(conn => {
            consumedRate += getConnectionRate(conn);
          });
          
          // If not fully consumed, the surplus is an external output
          if (consumedRate < out.rate - 0.01) {
            const surplus = out.rate - consumedRate;
            outputsMap.set(out.materialId, (outputsMap.get(out.materialId) || 0) + surplus);
            console.log(`Unconnected output: ${getMaterialById(out.materialId)?.name} @ ${surplus}/min (surplus)`);
          }
        });
      }
    });
    
    // Convert maps to arrays
    const inputs = Array.from(inputsMap.entries()).map(([materialId, rate]) => ({
      materialId,
      rate,
    }));
    
    const outputs = Array.from(outputsMap.entries()).map(([materialId, rate]) => ({
      materialId,
      rate,
    }));
    
    console.log("\n=== Blueprint Analysis Results ===");
    console.log("Inputs:", inputs);
    console.log("Outputs:", outputs);
    console.log("=== End Analysis ===\n");
    
    return {
      machines,
      inputs,
      outputs,
    };
  }
  
  function saveBlueprintFromDialog() {
    const nameInput = $("#blueprintName");
    const descInput = $("#blueprintDescription");
    
    if (!nameInput) return;
    
    const name = nameInput.value.trim();
    if (!name) {
      setStatus("Blueprint name is required.", "error");
      nameInput.focus();
      return;
    }
    
    const description = descInput?.value.trim() || "";
    
    // Get the analysis again
    const analysis = analyzeBlueprintMachines(state.build.selectedMachines);
    
    // Deep copy the machines (excluding their x, y positions - we'll calculate relative positions)
    const firstMachine = analysis.machines[0];
    const originX = firstMachine.x;
    const originY = firstMachine.y;
    
    // Create a mapping from current IDs to blueprint template IDs
    const idToBlueprintId = new Map();
    
    const machines = analysis.machines.map((pm, idx) => {
      // Deep copy machine data
      const copy = JSON.parse(JSON.stringify(pm));
      // Store relative position from first machine
      copy.x = pm.x - originX;
      copy.y = pm.y - originY;
      // Use a sequential ID for blueprint template
      const blueprintId = `bpm_${idx}`;
      idToBlueprintId.set(pm.id, blueprintId);
      copy.blueprintMachineId = blueprintId;
      delete copy.id; // Will be assigned when placed
      return copy;
    });
    
    // Deep copy connections between selected machines with mapped IDs
    const selectedSet = new Set(state.build.selectedMachines);
    const connections = state.build.connections
      .filter(conn => selectedSet.has(conn.fromMachineId) && selectedSet.has(conn.toMachineId))
      .map(conn => {
        return {
          fromMachineId: idToBlueprintId.get(conn.fromMachineId),
          fromPortIdx: conn.fromPortIdx,
          toMachineId: idToBlueprintId.get(conn.toMachineId),
          toPortIdx: conn.toPortIdx,
        };
      });
    
    // Create blueprint object
    const blueprint = {
      id: makeId("bp"),
      name,
      description,
      machines,
      connections,
      inputs: analysis.inputs,
      outputs: analysis.outputs,
      createdAt: new Date().toISOString(),
    };
    
    // Add to database
    state.db.blueprints.push(blueprint);
    
    // Invalidate cache since we added a new blueprint
    invalidateBlueprintCountCache(blueprint.id);
    
    saveDb();
    renderBlueprintsList();
    
    // Replace selected machines with blueprint instance
    replaceSelectionWithBlueprint(blueprint, selectedSet, analysis);
    
    closeDialog();
    setStatus(`Blueprint "${name}" created and placed on canvas.`);
  }
  
  function replaceSelectionWithBlueprint(blueprint, selectedSet, analysis) {
    // Calculate center position of selected machines
    const selectedMachines = state.build.placedMachines.filter(pm => selectedSet.has(pm.id));
    if (selectedMachines.length === 0) return;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedMachines.forEach(pm => {
      minX = Math.min(minX, pm.x);
      minY = Math.min(minY, pm.y);
      maxX = Math.max(maxX, pm.x + 300); // Approximate machine width
      maxY = Math.max(maxY, pm.y + 200); // Approximate machine height
    });
    
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    // Find external connections (connections crossing the selection boundary)
    // IMPORTANT: Capture material IDs BEFORE deleting machines
    const externalConnections = [];
    state.build.connections.forEach(conn => {
      const fromInside = selectedSet.has(conn.fromMachineId);
      const toInside = selectedSet.has(conn.toMachineId);
      
      if (fromInside !== toInside) {
        // Connection crosses boundary - capture material ID now
        let materialId = null;
        
        if (fromInside) {
          // Output connection - get material from source machine (inside)
          const sourceMachine = state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
          if (sourceMachine) {
            materialId = getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          }
        } else {
          // Input connection - get material from source machine (outside)
          const sourceMachine = state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
          if (sourceMachine) {
            materialId = getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          }
        }
        
        externalConnections.push({
          ...conn,
          fromInside,
          toInside,
          materialId // Store material ID for reconnection
        });
      }
    });
    
    // Create blueprint instance
    const blueprintInstance = {
      id: makeId("pm"),
      type: "blueprint",
      blueprintId: blueprint.id,
      x: centerX - 150, // Center the blueprint card
      y: centerY - 100,
      blueprintData: {
        name: blueprint.name,
        description: blueprint.description,
        inputs: blueprint.inputs,
        outputs: blueprint.outputs,
        machines: blueprint.machines,
        connections: blueprint.connections,
      }
    };
    
    // Remove connections to/from selected machines
    state.build.connections = state.build.connections.filter(conn => 
      !selectedSet.has(conn.fromMachineId) && !selectedSet.has(conn.toMachineId)
    );
    
    // Remove selected machines
    state.build.placedMachines = state.build.placedMachines.filter(pm => !selectedSet.has(pm.id));
    
    // Add blueprint instance
    state.build.placedMachines.push(blueprintInstance);
    
    // Try to reconnect external connections to blueprint ports
    reconnectExternalConnectionsToBlueprint(externalConnections, blueprintInstance, selectedSet);
    
    // Clear selection
    state.build.selectedMachines = [blueprintInstance.id];
    
    saveBuild();
    renderCanvas(true);
    updateSelectionClasses();
  }
  
  function reconnectExternalConnectionsToBlueprint(externalConnections, blueprintInstance, originalSelectedSet) {
    const blueprint = blueprintInstance.blueprintData;
    
    externalConnections.forEach(conn => {
      if (!conn.materialId) return; // Skip if we couldn't determine material
      
      if (conn.toInside) {
        // Connection FROM outside TO inside (blueprint input)
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
        if (!sourceMachine) return;
        
        // Find matching blueprint input port by material ID
        const inputIndex = blueprint.inputs.findIndex(inp => inp.materialId === conn.materialId);
        if (inputIndex >= 0) {
          // Create new connection to blueprint input
          state.build.connections.push({
            id: makeId("conn"),
            fromMachineId: conn.fromMachineId,
            fromPortIdx: conn.fromPortIdx,
            toMachineId: blueprintInstance.id,
            toPortIdx: String(inputIndex),
          });
          console.log(`Reconnected input: ${getMaterialById(conn.materialId)?.name} from ${conn.fromMachineId} to blueprint port ${inputIndex}`);
        }
      } else if (conn.fromInside) {
        // Connection FROM inside TO outside (blueprint output)
        const targetMachine = state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
        if (!targetMachine) return;
        
        // Find matching blueprint output port by material ID (captured before deletion)
        const outputIndex = blueprint.outputs.findIndex(out => out.materialId === conn.materialId);
        
        if (outputIndex >= 0) {
          // Create new connection from blueprint output
          state.build.connections.push({
            id: makeId("conn"),
            fromMachineId: blueprintInstance.id,
            fromPortIdx: String(outputIndex),
            toMachineId: conn.toMachineId,
            toPortIdx: conn.toPortIdx,
          });
          console.log(`Reconnected output: ${getMaterialById(conn.materialId)?.name} from blueprint port ${outputIndex} to ${conn.toMachineId}`);
        }
      }
    });
  }
  
  function deleteBlueprint(blueprintId) {
    if (!blueprintId) return;
    
    const blueprint = state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) return;
    
    // Check if blueprint is used in other blueprints (nested)
    const usedInBlueprints = state.db.blueprints.filter(bp => {
      if (bp.id === blueprintId) return false; // Don't check self
      return bp.machines.some(m => m.type === "blueprint" && m.blueprintId === blueprintId);
    });
    
    // Check if blueprint is placed on the canvas
    const placedInstances = state.build.placedMachines.filter(
      pm => pm.type === "blueprint" && pm.blueprintId === blueprintId
    );
    
    // Check if blueprint is in the edit stack (currently being edited)
    const isBeingEdited = state.blueprintEditStack.some(frame => {
      return frame.placedMachines.some(pm => pm.type === "blueprint" && pm.blueprintId === blueprintId);
    });
    
    // Build error message if in use
    const errors = [];
    if (usedInBlueprints.length > 0) {
      const blueprintNames = usedInBlueprints.map(bp => `"${bp.name}"`).join(", ");
      errors.push(`Used in ${usedInBlueprints.length} other blueprint${usedInBlueprints.length > 1 ? 's' : ''}: ${blueprintNames}`);
    }
    if (placedInstances.length > 0) {
      errors.push(`${placedInstances.length} instance${placedInstances.length > 1 ? 's' : ''} placed on the canvas`);
    }
    if (isBeingEdited) {
      errors.push(`Currently being edited in a nested blueprint`);
    }
    
    if (errors.length > 0) {
      alert(`Cannot delete blueprint "${blueprint.name}":\n\n• ${errors.join("\n• ")}\n\nRemove all usages first.`);
      return;
    }
    
    // Safe to delete
    if (!confirm(`Delete blueprint "${blueprint.name}"? This action cannot be undone.`)) return;
    
    state.db.blueprints = state.db.blueprints.filter(bp => bp.id !== blueprintId);
    
    // Invalidate cache
    invalidateBlueprintCountCache(blueprintId);
    
    saveDb();
    renderBlueprintsList();
    setStatus(`Blueprint "${blueprint.name}" deleted.`);
  }
  
  /**
   * Calculate total machine counts for a blueprint (recursively traversing nested blueprints)
   * Uses caching for performance with large blueprints
   * @param {string} blueprintId - Blueprint ID
   * @returns {{ totalCount: number, breakdown: Object }} - Total count and breakdown by machine type
   */
  function calculateBlueprintMachineCounts(blueprintId) {
    // Check cache first
    if (state.blueprintMachineCountCache[blueprintId]) {
      return state.blueprintMachineCountCache[blueprintId];
    }
    
    const blueprint = state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) {
      return { totalCount: 0, breakdown: {} };
    }
    
    let totalCount = 0;
    const breakdown = {}; // { machineId or "blueprint:blueprintId": count }
    
    blueprint.machines.forEach(pm => {
      const count = pm.count || 1;
      
      if (pm.type === "blueprint" && pm.blueprintId) {
        // Nested blueprint - recursively calculate
        const nestedCounts = calculateBlueprintMachineCounts(pm.blueprintId);
        totalCount += nestedCounts.totalCount * count;
        
        // Merge nested breakdown into this one
        for (const key in nestedCounts.breakdown) {
          breakdown[key] = (breakdown[key] || 0) + (nestedCounts.breakdown[key] * count);
        }
      } else {
        // Regular machine
        totalCount += count;
        
        // Group by machine type
        let machineKey;
        if (pm.type === "purchasing_portal") {
          machineKey = "purchasing_portal";
        } else if (pm.type === "fuel_source") {
          machineKey = "fuel_source";
        } else if (pm.type === "nursery") {
          machineKey = "nursery";
        } else if (pm.machineId) {
          machineKey = pm.machineId;
        } else {
          machineKey = "unknown";
        }
        
        breakdown[machineKey] = (breakdown[machineKey] || 0) + count;
      }
    });
    
    const result = { totalCount, breakdown };
    state.blueprintMachineCountCache[blueprintId] = result;
    return result;
  }
  
  /**
   * Invalidate blueprint machine count cache for a specific blueprint and all blueprints that contain it
   * @param {string} blueprintId - Blueprint ID to invalidate
   */
  function invalidateBlueprintCountCache(blueprintId) {
    // Clear the cache for this blueprint
    delete state.blueprintMachineCountCache[blueprintId];
    
    // Find and clear cache for any blueprints that contain this one
    state.db.blueprints.forEach(bp => {
      if (bp.machines.some(m => m.type === "blueprint" && m.blueprintId === blueprintId)) {
        invalidateBlueprintCountCache(bp.id); // Recursively invalidate parents
      }
    });
  }
  
  function renderBlueprintsList() {
    const listEl = $("#blueprintsList");
    if (!listEl) return;
    
    if (state.db.blueprints.length === 0) {
      listEl.innerHTML = '<div class="emptyState">No blueprints yet. Select machines and click 📐 to create one.</div>';
      return;
    }
    
    listEl.innerHTML = state.db.blueprints.map(bp => {
      const machineCount = calculateBlueprintMachineCounts(bp.id);
      
      // Build inputs HTML
      const inputsHTML = (bp.inputs || []).map(input => {
        const material = getMaterialById(input.materialId);
        const materialName = material ? material.name : "Unknown";
        return `
          <div class="blueprintCard__ioItem">
            <span class="blueprintCard__ioIcon">📥</span>
            <span>${escapeHtml(materialName)}: ${input.rate.toFixed(1)}/min</span>
          </div>
        `;
      }).join('');
      
      // Build outputs HTML
      const outputsHTML = (bp.outputs || []).map(output => {
        const material = getMaterialById(output.materialId);
        const materialName = material ? material.name : "Unknown";
        return `
          <div class="blueprintCard__ioItem">
            <span class="blueprintCard__ioIcon">📤</span>
            <span>${escapeHtml(materialName)}: ${output.rate.toFixed(1)}/min</span>
          </div>
        `;
      }).join('');
      
      // Build machine breakdown HTML
      const breakdownItems = [];
      for (const machineKey in machineCount.breakdown) {
        const count = machineCount.breakdown[machineKey];
        let machineName = "Unknown";
        
        if (machineKey === "purchasing_portal") {
          machineName = "Purchasing Portal";
        } else if (machineKey === "fuel_source") {
          machineName = "Fuel Source";
        } else if (machineKey === "nursery") {
          machineName = "Nursery";
        } else if (machineKey === "unknown") {
          machineName = "Unknown Machine";
        } else {
          const machine = getMachineById(machineKey);
          machineName = machine ? machine.name : "Unknown Machine";
        }
        
        breakdownItems.push({ name: machineName, count });
      }
      
      // Sort by count descending, then by name
      breakdownItems.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
      
      const breakdownHTML = breakdownItems.map(item => `
        <div style="display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px;">
          <span>${escapeHtml(item.name)}</span>
          <span style="font-weight: 600; color: var(--accent);">×${item.count}</span>
        </div>
      `).join('');
      
      return `
        <div class="blueprintCard" data-blueprint-id="${bp.id}" draggable="true">
          <div class="blueprintCard__header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
            <div class="blueprintCard__name">${escapeHtml(bp.name)}</div>
            <button class="btn btn--danger btn--sm" data-action="blueprint:delete" data-blueprint-delete-id="${bp.id}" title="Delete Blueprint" style="padding: 2px 6px; font-size: 11px;">✕</button>
          </div>
          ${bp.description ? `<div class="blueprintCard__description">${escapeHtml(bp.description)}</div>` : ''}
          <div class="blueprintCard__stats">
            <span>🏭 ${machineCount.totalCount} machine${machineCount.totalCount !== 1 ? 's' : ''}</span>
          </div>
          ${breakdownHTML ? `
            <details class="blueprintCard__breakdown">
              <summary style="cursor: pointer; font-size: 11px; color: var(--muted); margin-top: 8px; user-select: none;">
                ▸ Show machine breakdown
              </summary>
              <div style="margin-top: 6px; padding: 8px; background: rgba(0,0,0,.2); border-radius: 6px;">
                ${breakdownHTML}
              </div>
            </details>
          ` : ''}
          ${inputsHTML || outputsHTML ? `
            <div class="blueprintCard__io">
              ${inputsHTML ? `
                <div class="blueprintCard__ioSection">
                  <div class="blueprintCard__ioTitle">Inputs</div>
                  <div class="blueprintCard__ioList">${inputsHTML}</div>
                </div>
              ` : ''}
              ${outputsHTML ? `
                <div class="blueprintCard__ioSection">
                  <div class="blueprintCard__ioTitle">Outputs</div>
                  <div class="blueprintCard__ioList">${outputsHTML}</div>
                </div>
              ` : ''}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    
    // Add drag handlers
    listEl.querySelectorAll('.blueprintCard').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        // Don't start drag if clicking the delete button
        if (e.target.closest('[data-action="blueprint:delete"]')) {
          e.preventDefault();
          return;
        }
        
        const blueprintId = card.dataset.blueprintId;
        e.dataTransfer.setData('blueprintId', blueprintId);
        e.dataTransfer.effectAllowed = 'copy';
      });
      
      // Prevent delete button from triggering drag
      const deleteBtn = card.querySelector('[data-action="blueprint:delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
      }
    });
  }
  
  function placeBlueprintOnCanvas(blueprintId, x, y) {
    const blueprint = state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) return;
    
    // Create a single "blueprint" machine that acts as a black box
    const blueprintMachine = {
      id: makeId("pm"),
      type: "blueprint",
      blueprintId: blueprint.id,
      x,
      y,
      // Store blueprint data for rendering
      blueprintData: {
        name: blueprint.name,
        description: blueprint.description,
        inputs: blueprint.inputs,
        outputs: blueprint.outputs,
        machines: blueprint.machines, // For stats calculation
        connections: blueprint.connections, // For editing
      }
    };
    
    state.build.placedMachines.push(blueprintMachine);
    
    // Select the newly placed blueprint
    state.build.selectedMachines = [blueprintMachine.id];
    
    saveBuild();
    renderCanvas(true); // Force recreation to show new machine
    updateSelectionClasses();
    
    setStatus(`Blueprint "${blueprint.name}" placed on canvas.`);
  }
  
  function enterBlueprintEditMode(instanceId) {
    const placedMachine = state.build.placedMachines.find(pm => pm.id === instanceId);
    if (!placedMachine || placedMachine.type !== "blueprint") return;
    
    const blueprint = state.db.blueprints.find(bp => bp.id === placedMachine.blueprintId);
    if (!blueprint) {
      setStatus("Blueprint definition not found.", "error");
      return;
    }
    
    // Push current canvas state to stack (including current edit context if nested)
    state.blueprintEditStack.push({
      placedMachines: JSON.parse(JSON.stringify(state.build.placedMachines)),
      connections: JSON.parse(JSON.stringify(state.build.connections)),
      camera: { ...state.build.camera },
      selectedMachines: [...state.build.selectedMachines],
      editContext: state.currentBlueprintEdit ? JSON.parse(JSON.stringify(state.currentBlueprintEdit)) : null,
    });
    
    // Set edit context
    state.currentBlueprintEdit = {
      blueprintId: blueprint.id,
      instanceId: instanceId,
      originalBlueprint: JSON.parse(JSON.stringify(blueprint)), // Keep copy for validation
    };
    
    // Load blueprint machines onto canvas with proper IDs
    // Generate new IDs for the machines when loading them into edit mode
    const idMap = new Map();
    const machines = blueprint.machines.map(templateMachine => {
      const newId = makeId("pm");
      idMap.set(templateMachine.blueprintMachineId, newId);
      
      const machine = JSON.parse(JSON.stringify(templateMachine));
      machine.id = newId;
      // Keep the relative positions from blueprint
      return machine;
    });
    
    // Remap connections to use the new machine IDs and add connection IDs
    const connections = (blueprint.connections || []).map(templateConn => {
      return {
        id: makeId("conn"),
        fromMachineId: idMap.get(templateConn.fromMachineId),
        fromPortIdx: templateConn.fromPortIdx,
        toMachineId: idMap.get(templateConn.toMachineId),
        toPortIdx: templateConn.toPortIdx,
      };
    });
    
    state.build.placedMachines = machines;
    state.build.connections = connections;
    state.build.selectedMachines = [];
    state.build.camera = { x: 0, y: 0, zoom: 1.0 };
    
    // Update canvas subtitle to show we're editing
    renderCanvas(true);
    updateBlueprintEditUI();
    
    setStatus(`Editing blueprint: ${blueprint.name}`);
  }
  
  function exitBlueprintEditMode(skipSave = false) {
    if (state.blueprintEditStack.length === 0) {
      setStatus("Not currently editing a blueprint.", "warning");
      return;
    }
    
    if (!skipSave && (state.build.placedMachines.length > 0 || state.build.connections.length > 0)) {
      if (!confirm("Exit without saving changes?")) {
        return;
      }
    }
    
    // Pop canvas state from stack
    const previousState = state.blueprintEditStack.pop();
    state.build.placedMachines = previousState.placedMachines;
    state.build.connections = previousState.connections;
    state.build.camera = previousState.camera;
    state.build.selectedMachines = previousState.selectedMachines;
    
    // Restore previous edit context (if we're still in nested editing)
    state.currentBlueprintEdit = previousState.editContext;
    
    // Persist the restored state
    // If we're back to main canvas, this saves it to localStorage
    // If we're still nested, saveBuild() will save the main canvas from stack bottom
    saveBuild();
    
    renderCanvas(true);
    updateBlueprintEditUI();
    setStatus("Exited blueprint edit mode.");
  }
  
  function saveBlueprintEdit() {
    if (!state.currentBlueprintEdit) {
      setStatus("Not currently editing a blueprint.", "error");
      return;
    }
    
    const { blueprintId, instanceId, originalBlueprint } = state.currentBlueprintEdit;
    const blueprint = state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) {
      setStatus("Blueprint not found.", "error");
      return;
    }
    
    // Analyze current canvas to get new inputs/outputs
    const machineIds = state.build.placedMachines.map(pm => pm.id);
    const analysis = analyzeBlueprintMachines(machineIds);
    
    // Check if inputs/outputs have changed
    const inputsChanged = !portsMatch(originalBlueprint.inputs, analysis.inputs);
    const outputsChanged = !portsMatch(originalBlueprint.outputs, analysis.outputs);
    
    if (inputsChanged || outputsChanged) {
      const msg = "Blueprint inputs/outputs have changed. This will disconnect existing connections to this blueprint instance" + 
        (countBlueprintInstances(blueprintId) > 1 ? " (and potentially other instances)" : "") + 
        ". Continue?";
      if (!confirm(msg)) return;
    }
    
    // Update blueprint definition with properly mapped machines and connections
    // Calculate relative positions from first machine
    const firstMachine = state.build.placedMachines[0];
    const originX = firstMachine?.x || 0;
    const originY = firstMachine?.y || 0;
    
    // Create a mapping from current IDs to blueprint template IDs
    const idToBlueprintId = new Map();
    
    const machines = state.build.placedMachines.map((pm, idx) => {
      // Deep copy machine data
      const copy = JSON.parse(JSON.stringify(pm));
      // Store relative position from first machine
      copy.x = pm.x - originX;
      copy.y = pm.y - originY;
      // Use a sequential ID for blueprint template
      const blueprintId = `bpm_${idx}`;
      idToBlueprintId.set(pm.id, blueprintId);
      copy.blueprintMachineId = blueprintId;
      delete copy.id; // Will be assigned when placed
      return copy;
    });
    
    // Deep copy connections with mapped IDs
    const connections = state.build.connections.map(conn => {
      return {
        fromMachineId: idToBlueprintId.get(conn.fromMachineId),
        fromPortIdx: conn.fromPortIdx,
        toMachineId: idToBlueprintId.get(conn.toMachineId),
        toPortIdx: conn.toPortIdx,
      };
    });
    
    blueprint.machines = machines;
    blueprint.connections = connections;
    blueprint.inputs = analysis.inputs;
    blueprint.outputs = analysis.outputs;
    
    // Invalidate cache since blueprint was modified
    invalidateBlueprintCountCache(blueprintId);
    
    saveDb();
    
    // Update all instances of this blueprint on parent canvas
    const parentState = state.blueprintEditStack[state.blueprintEditStack.length - 1];
    if (parentState) {
      parentState.placedMachines.forEach(pm => {
        if (pm.type === "blueprint" && pm.blueprintId === blueprintId) {
          pm.blueprintData = {
            name: blueprint.name,
            description: blueprint.description,
            inputs: blueprint.inputs,
            outputs: blueprint.outputs,
            machines: blueprint.machines,
            connections: blueprint.connections,
          };
          
          // If inputs/outputs changed, remove connections that are now invalid
          if (inputsChanged || outputsChanged) {
            removeInvalidConnectionsForBlueprint(parentState.connections, pm.id, blueprint.inputs, blueprint.outputs);
          }
        }
      });
    }
    
    exitBlueprintEditMode(true);
    saveBuild();
    setStatus(`Blueprint "${blueprint.name}" updated.`);
  }
  
  function saveBlueprintAsNew() {
    if (!state.currentBlueprintEdit) {
      setStatus("Not currently editing a blueprint.", "error");
      return;
    }
    
    const originalBlueprint = state.db.blueprints.find(bp => bp.id === state.currentBlueprintEdit.blueprintId);
    if (!originalBlueprint) return;
    
    const newName = prompt("Enter name for new blueprint:", originalBlueprint.name + " (Copy)");
    if (!newName || !newName.trim()) return;
    
    // Analyze current canvas
    const machineIds = state.build.placedMachines.map(pm => pm.id);
    const analysis = analyzeBlueprintMachines(machineIds);
    
    // Calculate relative positions from first machine
    const firstMachine = state.build.placedMachines[0];
    const originX = firstMachine?.x || 0;
    const originY = firstMachine?.y || 0;
    
    // Create a mapping from current IDs to blueprint template IDs
    const idToBlueprintId = new Map();
    
    const machines = state.build.placedMachines.map((pm, idx) => {
      // Deep copy machine data
      const copy = JSON.parse(JSON.stringify(pm));
      // Store relative position from first machine
      copy.x = pm.x - originX;
      copy.y = pm.y - originY;
      // Use a sequential ID for blueprint template
      const blueprintId = `bpm_${idx}`;
      idToBlueprintId.set(pm.id, blueprintId);
      copy.blueprintMachineId = blueprintId;
      delete copy.id; // Will be assigned when placed
      return copy;
    });
    
    // Deep copy connections with mapped IDs
    const connections = state.build.connections.map(conn => {
      return {
        fromMachineId: idToBlueprintId.get(conn.fromMachineId),
        fromPortIdx: conn.fromPortIdx,
        toMachineId: idToBlueprintId.get(conn.toMachineId),
        toPortIdx: conn.toPortIdx,
      };
    });
    
    // Create new blueprint
    const newBlueprint = {
      id: makeId("bp"),
      name: newName.trim(),
      description: originalBlueprint.description,
      machines,
      connections,
      inputs: analysis.inputs,
      outputs: analysis.outputs,
    };
    
    state.db.blueprints.push(newBlueprint);
    
    // Invalidate cache since we added a new blueprint
    invalidateBlueprintCountCache(newBlueprint.id);
    
    saveDb();
    renderBlueprintsList();
    
    // Ask if user wants to update the current instance to use the new blueprint
    if (confirm(`Update the edited instance to use the new blueprint "${newName}"?`)) {
      const parentState = state.blueprintEditStack[state.blueprintEditStack.length - 1];
      if (parentState) {
        const instance = parentState.placedMachines.find(pm => pm.id === state.currentBlueprintEdit.instanceId);
        if (instance) {
          instance.blueprintId = newBlueprint.id;
          instance.blueprintData = {
            name: newBlueprint.name,
            description: newBlueprint.description,
            inputs: newBlueprint.inputs,
            outputs: newBlueprint.outputs,
            machines: newBlueprint.machines,
            connections: newBlueprint.connections,
          };
        }
      }
    }
    
    exitBlueprintEditMode(true);
    saveBuild();
    setStatus(`New blueprint "${newName}" created.`);
  }
  
  function updateBlueprintEditUI() {
    const subtitle = $("#canvasSubtitle");
    if (!subtitle) return;
    
    if (state.currentBlueprintEdit) {
      const blueprint = state.db.blueprints.find(bp => bp.id === state.currentBlueprintEdit.blueprintId);
      const blueprintName = blueprint ? blueprint.name : "Unknown";
      const depth = state.blueprintEditStack.length;
      
      subtitle.innerHTML = `
        <span style="color: var(--accent); font-weight: bold;">📐 EDITING: ${escapeHtml(blueprintName)}</span>
        ${depth > 1 ? `<span style="color: var(--muted);"> (Depth: ${depth})</span>` : ""}
        <button class="btn btn--sm" data-action="blueprint:save-edit" title="Save changes to blueprint">💾 Save</button>
        <button class="btn btn--sm" data-action="blueprint:save-as-new" title="Save as new blueprint">📋 Save As New</button>
        <button class="btn btn--sm" data-action="blueprint:exit-edit" title="Exit without saving">❌ Exit</button>
      `;
    } else {
      // Restore normal subtitle
      const speed = getEffectiveConveyorSpeed();
      const { x: camX, y: camY, zoom } = state.build.camera;
      const zoomPercent = Math.round(zoom * 100);
      subtitle.innerHTML = `Conveyor: ${speed}/min | <span class="canvas__coords" title="Click to jump to coordinates">Position: (${Math.round(camX)}, ${Math.round(camY)})</span> | Zoom: ${zoomPercent}%`;
    }
  }
  
  function portsMatch(portsA, portsB) {
    if (portsA.length !== portsB.length) return false;
    
    // Create maps of materialId -> rate
    const mapA = new Map(portsA.map(p => [p.materialId, p.rate]));
    const mapB = new Map(portsB.map(p => [p.materialId, p.rate]));
    
    for (const [matId, rate] of mapA) {
      if (!mapB.has(matId) || Math.abs(mapB.get(matId) - rate) > 0.01) {
        return false;
      }
    }
    
    return true;
  }
  
  function countBlueprintInstances(blueprintId) {
    return state.build.placedMachines.filter(pm => 
      pm.type === "blueprint" && pm.blueprintId === blueprintId
    ).length;
  }
  
  function removeInvalidConnectionsForBlueprint(connections, blueprintInstanceId, newInputs, newOutputs) {
    // Remove connections to input ports that no longer exist
    const validInputMaterials = new Set(newInputs.map(inp => inp.materialId));
    const validOutputMaterials = new Set(newOutputs.map(out => out.materialId));
    
    const toRemove = [];
    
    connections.forEach((conn, idx) => {
      // Check connections TO this blueprint (inputs)
      if (conn.toMachineId === blueprintInstanceId) {
        const sourceMachine = state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
        if (sourceMachine) {
          const materialId = getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          if (!validInputMaterials.has(materialId)) {
            toRemove.push(idx);
          }
        }
      }
      
      // Check connections FROM this blueprint (outputs)
      if (conn.fromMachineId === blueprintInstanceId) {
        const blueprintMachine = state.build.placedMachines.find(pm => pm.id === blueprintInstanceId);
        if (blueprintMachine) {
          const materialId = getMaterialIdFromPort(blueprintMachine, conn.fromPortIdx, "output");
          if (!validOutputMaterials.has(materialId)) {
            toRemove.push(idx);
          }
        }
      }
    });
    
    // Remove invalid connections (in reverse order to maintain indices)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      connections.splice(toRemove[i], 1);
    }
  }
  
  function openSkillsDialog() {
    const dialog = $("#skillsDialog");
    if (!dialog) return;
    
    renderSkillsList();
    dialog.classList.remove("hidden");
    
    // Close on overlay click
    const overlay = dialog.querySelector(".dialog__overlay");
    if (overlay) {
      overlay.onclick = closeDialog;
    }
  }
  
  function closeDialog() {
    const skillsDialog = $("#skillsDialog");
    const productionDialog = $("#productionDialog");
    const jumpDialog = $("#jumpToCoordinatesDialog");
    const storageDialog = $("#storageSelectionDialog");
    const manualStorageDialog = $("#manualStorageDialog");
    const topperDialog = $("#addTopperDialog");
    const blueprintDialog = $("#createBlueprintDialog");
    const blueprintSelectDialog = $("#blueprintSelectionDialog");
    if (skillsDialog) skillsDialog.classList.add("hidden");
    if (productionDialog) productionDialog.classList.add("hidden");
    if (jumpDialog) jumpDialog.classList.add("hidden");
    if (storageDialog) {
      storageDialog.classList.add("hidden");
      // Reset title to default
      const title = storageDialog.querySelector(".dialog__title");
      if (title) title.textContent = "Select Storage Type";
    }
    if (manualStorageDialog) manualStorageDialog.classList.add("hidden");
    if (topperDialog) topperDialog.classList.add("hidden");
    if (blueprintDialog) blueprintDialog.classList.add("hidden");
    if (blueprintSelectDialog) blueprintSelectDialog.classList.add("hidden");
    
    // Clear pending state
    state.ui.pendingStorageReplacementId = null;
    state.ui.pendingHeatingDeviceId = null;
    state.ui.pendingBlueprintCoords = null;
  }
  
  function openStorageSelectionDialog(x, y) {
    const storageMachines = state.db.machines.filter(m => m.kind === "storage");
    
    if (storageMachines.length === 0) {
      setStatus("No storage machines configured. Add a storage machine first.", "error");
      return;
    }
    
    // Store coordinates for later use
    state.ui.pendingStorageCoords = { x, y };
    
    renderStorageTypesList();
    
    const dialog = $("#storageSelectionDialog");
    if (dialog) {
      // Ensure dialog title is set for adding mode
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = "Select Storage Type";
      dialog.classList.remove("hidden");
    }
  }
  
  function openBlueprintSelectionDialog(x, y) {
    if (state.db.blueprints.length === 0) {
      setStatus("No blueprints available. Create a blueprint first.", "error");
      return;
    }
    
    // Store coordinates for later use
    state.ui.pendingBlueprintCoords = { x, y };
    
    renderBlueprintSelectionList();
    
    const dialog = $("#blueprintSelectionDialog");
    if (dialog) {
      dialog.classList.remove("hidden");
      // Focus search input
      const searchInput = dialog.querySelector("#blueprintSelectionSearch");
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }
    }
  }
  
  function renderBlueprintSelectionList(filter = "") {
    const listEl = $("#blueprintSelectionList");
    if (!listEl) return;
    
    const filteredBlueprints = state.db.blueprints.filter(bp => 
      !filter || bp.name.toLowerCase().includes(filter.toLowerCase())
    );
    
    if (filteredBlueprints.length === 0) {
      listEl.innerHTML = '<div class="emptyState">No blueprints found.</div>';
      return;
    }
    
    listEl.innerHTML = filteredBlueprints.map(bp => {
      const machineCount = bp.machines.length;
      return `
        <div class="storageTypeItem" data-blueprint-select-id="${bp.id}">
          <div class="storageTypeItem__name">📐 ${escapeHtml(bp.name)}</div>
          <div class="storageTypeItem__meta">${machineCount} machine${machineCount !== 1 ? 's' : ''} • ${bp.inputs.length} in / ${bp.outputs.length} out</div>
        </div>
      `;
    }).join('');
  }
  
  function openManualStorageDialog(machineId) {
    // Store the machine ID for later use
    state.ui.pendingManualStorageMachineId = machineId;
    
    const placedMachine = state.build.placedMachines.find(pm => pm.id === machineId);
    if (!placedMachine) return;
    
    const machine = getMachineById(placedMachine.machineId);
    if (!machine || machine.kind !== "storage") return;
    
    const maxSlots = placedMachine.storageSlots || machine.storageSlots;
    const manualInventories = placedMachine.manualInventories || [];
    const usedSlots = manualInventories.reduce((sum, inv) => sum + (inv.slotsAllocated || 0), 0);
    const availableSlots = maxSlots - usedSlots;
    
    if (availableSlots <= 0) {
      setStatus("Storage is full. Remove a material first.", "error");
      return;
    }
    
    // Populate material options
    const form = $("#manualStorageForm");
    if (!form) return;
    
    const select = form.querySelector("select[name='materialId']");
    if (select) {
      const materialOptions = state.db.materials.map(m => 
        `<option value="${m.id}">${escapeHtml(m.name)}</option>`
      ).join("");
      select.innerHTML = `<option value="">(select material)</option>${materialOptions}`;
    }
    
    // Set max slots
    const slotsInput = form.querySelector("input[name='slotsAllocated']");
    if (slotsInput) {
      slotsInput.setAttribute("max", String(availableSlots));
      slotsInput.value = "1";
    }
    
    // Reset form
    form.reset();
    form.querySelector("input[name='currentAmount']").value = "0";
    
    const dialog = $("#manualStorageDialog");
    if (dialog) dialog.classList.remove("hidden");
  }
  
  function saveManualStorageMaterial() {
    const form = $("#manualStorageForm");
    if (!form) return;
    
    const machineId = state.ui.pendingManualStorageMachineId;
    if (!machineId) return;
    
    const placedMachine = state.build.placedMachines.find(pm => pm.id === machineId);
    if (!placedMachine) return;
    
    const formData = new FormData(form);
    const materialId = formData.get("materialId");
    const slotsAllocated = parseInt(formData.get("slotsAllocated")) || 1;
    const currentAmount = parseInt(formData.get("currentAmount")) || 0;
    
    if (!materialId) {
      setStatus("Please select a material.", "error");
      return;
    }
    
    // Initialize manualInventories if needed
    if (!placedMachine.manualInventories) {
      placedMachine.manualInventories = [];
    }
    
    // Add the material
    placedMachine.manualInventories.push({
      materialId,
      slotsAllocated,
      currentAmount
    });
    
    saveBuild();
    renderCanvas(true); // Force recreation since storage content changed
    closeDialog();
    state.ui.pendingManualStorageMachineId = null;
    setStatus("Material added to storage.");
  }
  
  function removeManualStorageMaterial(machineId, idx) {
    const placedMachine = state.build.placedMachines.find(pm => pm.id === machineId);
    if (!placedMachine || !placedMachine.manualInventories) return;
    
    placedMachine.manualInventories.splice(idx, 1);
    
    saveBuild();
    renderCanvas(true); // Force recreation since storage content changed
    setStatus("Material removed from storage.");
  }
  
  function openStorageTypeChangeDialog(placedMachineId) {
    const storageMachines = state.db.machines.filter(m => m.kind === "storage");
    
    if (storageMachines.length === 0) {
      setStatus("No storage machines configured.", "error");
      return;
    }
    
    // Store the machine ID we're replacing
    state.ui.pendingStorageReplacementId = placedMachineId;
    
    renderStorageTypesList();
    
    const dialog = $("#storageSelectionDialog");
    if (dialog) {
      // Update dialog title for replacement mode
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = "Change Storage Type";
      dialog.classList.remove("hidden");
    }
  }
  
  // ---------- Heating Device Topper Management ----------
  
  function openAddTopperDialog(heatingDeviceId) {
    const placedMachine = state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine) return;
    
    const machine = getMachineById(placedMachine.machineId);
    if (!machine || machine.kind !== "heating_device") return;
    
    // Get available topper machines (requiresFurnace = true)
    const topperMachines = state.db.machines.filter(m => m.requiresFurnace);
    
    if (topperMachines.length === 0) {
      setStatus("No topper machines configured.", "error");
      return;
    }
    
    // Store the heating device ID
    state.ui.pendingHeatingDeviceId = heatingDeviceId;
    
    // Populate topper machines dropdown
    const form = $("#addTopperForm");
    if (!form) return;
    
    const machineSelect = form.querySelector('[name="topperMachineId"]');
    if (machineSelect) {
      machineSelect.innerHTML = '<option value="">(select topper machine)</option>' + 
        topperMachines.map(m => 
          `<option value="${m.id}">${escapeHtml(m.name)} (${m.footprintWidth || 1}x${m.footprintLength || 1} tiles, ${m.heatConsumptionP || 0}P)</option>`
        ).join("");
      
      // Update recipe dropdown when machine changes
      machineSelect.addEventListener("change", updateTopperRecipeOptions);
    }
    
    // Show dialog
    const dialog = $("#addTopperDialog");
    if (dialog) {
      dialog.classList.remove("hidden");
    }
  }
  
  function updateTopperRecipeOptions() {
    const form = $("#addTopperForm");
    if (!form) return;
    
    const machineSelect = form.querySelector('[name="topperMachineId"]');
    const recipeSelect = form.querySelector('[name="topperRecipeId"]');
    if (!machineSelect || !recipeSelect) return;
    
    const selectedMachineId = machineSelect.value;
    
    if (!selectedMachineId) {
      recipeSelect.innerHTML = '<option value="">(no recipe)</option>';
      return;
    }
    
    // Get recipes for this machine
    const recipes = state.db.recipes.filter(r => r.machineId === selectedMachineId);
    
    recipeSelect.innerHTML = '<option value="">(no recipe)</option>' + 
      recipes.map(r => 
        `<option value="${r.id}">${escapeHtml(r.name)}</option>`
      ).join("");
  }
  
  function saveTopperFromDialog() {
    const form = $("#addTopperForm");
    if (!form) return;
    
    const heatingDeviceId = state.ui.pendingHeatingDeviceId;
    if (!heatingDeviceId) return;
    
    const placedMachine = state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine) return;
    
    const machine = getMachineById(placedMachine.machineId);
    if (!machine || machine.kind !== "heating_device") return;
    
    const fd = new FormData(form);
    const topperMachineId = fd.get("topperMachineId");
    const topperRecipeId = fd.get("topperRecipeId") || null;
    
    if (!topperMachineId) {
      setStatus("Please select a topper machine.", "error");
      return;
    }
    
    const topperMachine = getMachineById(topperMachineId);
    if (!topperMachine) {
      setStatus("Invalid topper machine.", "error");
      return;
    }
    
    // Check if adding this topper would exceed heating area
    const totalArea = (machine.heatingAreaWidth || 1) * (machine.heatingAreaLength || 1);
    const topperFootprint = (topperMachine.footprintWidth || 1) * (topperMachine.footprintLength || 1);
    
    let usedArea = 0;
    (placedMachine.toppers || []).forEach(t => {
      const tm = getMachineById(t.machineId);
      if (tm) {
        usedArea += (tm.footprintWidth || 1) * (tm.footprintLength || 1);
      }
    });
    
    if (usedArea + topperFootprint > totalArea) {
      if (!confirm(`Adding this topper will exceed the heating area capacity (${usedArea + topperFootprint} / ${totalArea} tiles). Continue anyway?`)) {
        return;
      }
    }
    
    // Initialize toppers array if needed
    if (!placedMachine.toppers) {
      placedMachine.toppers = [];
    }
    
    // Add the topper
    placedMachine.toppers.push({
      machineId: topperMachineId,
      recipeId: topperRecipeId,
    });
    
    // Clear pending state
    state.ui.pendingHeatingDeviceId = null;
    
    // Close dialog
    closeDialog();
    
    // Save and re-render
    saveBuild();
    renderCanvas(true); // Force recreation since machine content changed
    setStatus("Topper added to heating device.");
  }
  
  function removeTopper(heatingDeviceId, topperIdx) {
    const placedMachine = state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine || !placedMachine.toppers) return;
    
    if (!confirm("Remove this topper from the heating device?")) return;
    
    const topper = placedMachine.toppers[topperIdx];
    const topperRecipe = topper?.recipeId ? getRecipeById(topper.recipeId) : null;
    
    // Collect materials used by this topper
    const inputMaterials = new Set();
    const outputMaterials = new Set();
    
    if (topperRecipe) {
      topperRecipe.inputs.forEach(inp => {
        if (inp.materialId) inputMaterials.add(inp.materialId);
      });
      topperRecipe.outputs.forEach(out => {
        if (out.materialId) outputMaterials.add(out.materialId);
      });
    }
    
    // Remove the topper
    placedMachine.toppers.splice(topperIdx, 1);
    
    // Check which materials are still produced/consumed by remaining toppers
    const remainingInputMaterials = new Set();
    const remainingOutputMaterials = new Set();
    
    placedMachine.toppers.forEach(t => {
      const recipe = t.recipeId ? getRecipeById(t.recipeId) : null;
      if (recipe) {
        recipe.inputs.forEach(inp => {
          if (inp.materialId) remainingInputMaterials.add(inp.materialId);
        });
        recipe.outputs.forEach(out => {
          if (out.materialId) remainingOutputMaterials.add(out.materialId);
        });
      }
    });
    
    // Remove connections to grouped ports for materials no longer produced/consumed
    state.build.connections = state.build.connections.filter(conn => {
      // Check input connections
      if (conn.toMachineId === heatingDeviceId && typeof conn.toPortIdx === 'string') {
        if (conn.toPortIdx.startsWith('grouped-input-')) {
          const materialId = conn.toPortIdx.replace(/^grouped-input-/, '');
          if (inputMaterials.has(materialId) && !remainingInputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }
      
      // Check output connections
      if (conn.fromMachineId === heatingDeviceId && typeof conn.fromPortIdx === 'string') {
        if (conn.fromPortIdx.startsWith('grouped-output-')) {
          const materialId = conn.fromPortIdx.replace(/^grouped-output-/, '');
          if (outputMaterials.has(materialId) && !remainingOutputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }
      
      return true;
    });
    
    saveBuild();
    renderCanvas(true); // Force recreation since machine content changed
    setStatus("Topper removed from heating device.");
  }
  
  function updateTopperRecipe(heatingDeviceId, topperIdx, recipeId) {
    const placedMachine = state.build.placedMachines.find(pm => pm.id === heatingDeviceId);
    if (!placedMachine || !placedMachine.toppers || !placedMachine.toppers[topperIdx]) return;
    
    const oldRecipe = placedMachine.toppers[topperIdx].recipeId ? getRecipeById(placedMachine.toppers[topperIdx].recipeId) : null;
    
    // Collect materials from old recipe
    const oldInputMaterials = new Set();
    const oldOutputMaterials = new Set();
    
    if (oldRecipe) {
      oldRecipe.inputs.forEach(inp => {
        if (inp.materialId) oldInputMaterials.add(inp.materialId);
      });
      oldRecipe.outputs.forEach(out => {
        if (out.materialId) oldOutputMaterials.add(out.materialId);
      });
    }
    
    // Update the recipe
    placedMachine.toppers[topperIdx].recipeId = recipeId;
    
    // Collect materials from all toppers after the update
    const allInputMaterials = new Set();
    const allOutputMaterials = new Set();
    
    placedMachine.toppers.forEach(t => {
      const recipe = t.recipeId ? getRecipeById(t.recipeId) : null;
      if (recipe) {
        recipe.inputs.forEach(inp => {
          if (inp.materialId) allInputMaterials.add(inp.materialId);
        });
        recipe.outputs.forEach(out => {
          if (out.materialId) allOutputMaterials.add(out.materialId);
        });
      }
    });
    
    // Remove connections to grouped ports for materials no longer produced/consumed
    state.build.connections = state.build.connections.filter(conn => {
      // Check input connections
      if (conn.toMachineId === heatingDeviceId && typeof conn.toPortIdx === 'string') {
        if (conn.toPortIdx.startsWith('grouped-input-')) {
          const materialId = conn.toPortIdx.replace(/^grouped-input-/, '');
          if (oldInputMaterials.has(materialId) && !allInputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }
      
      // Check output connections
      if (conn.fromMachineId === heatingDeviceId && typeof conn.fromPortIdx === 'string') {
        if (conn.fromPortIdx.startsWith('grouped-output-')) {
          const materialId = conn.fromPortIdx.replace(/^grouped-output-/, '');
          if (oldOutputMaterials.has(materialId) && !allOutputMaterials.has(materialId)) {
            return false; // Remove this connection
          }
        }
      }
      
      return true;
    });
    
    saveBuild();
    renderCanvas(true); // Force recreation since machine content changed
  }
  
  function replaceStorageType(placedMachineId, newMachineId) {
    const placedMachine = state.build.placedMachines.find(pm => pm.id === placedMachineId);
    if (!placedMachine) {
      setStatus("Machine not found.", "error");
      return;
    }
    
    const oldMachine = getMachineById(placedMachine.machineId);
    const newMachine = getMachineById(newMachineId);
    
    if (!oldMachine || !newMachine || oldMachine.kind !== "storage" || newMachine.kind !== "storage") {
      setStatus("Invalid storage machine.", "error");
      return;
    }
    
    // Check if manual inventories can fit in new storage
    const manualInventories = placedMachine.manualInventories || [];
    if (manualInventories.length > 0) {
      const totalSlotsNeeded = manualInventories.reduce((sum, inv) => sum + (inv.slotsAllocated || 0), 0);
      
      if (totalSlotsNeeded > newMachine.storageSlots) {
        const proceed = confirm(
          `Warning: The new storage has ${newMachine.storageSlots} slots, but the current storage is using ${totalSlotsNeeded} slots.\n\n` +
          `Changing to this storage will result in data loss. Do you want to continue?`
        );
        
        if (!proceed) {
          return;
        }
        
        // Clear manual inventories if user proceeds
        placedMachine.manualInventories = [];
      }
    }
    
    // Update to new machine type
    placedMachine.machineId = newMachineId;
    placedMachine.storageSlots = Math.min(
      placedMachine.storageSlots || newMachine.storageSlots,
      newMachine.storageSlots
    );
    
    // Reset dialog title back to default
    const dialog = $("#storageSelectionDialog");
    if (dialog) {
      const title = dialog.querySelector(".dialog__title");
      if (title) title.textContent = "Select Storage Type";
    }
    
    saveBuild();
    renderCanvas(true); // Force recreation since storage type changed
    setStatus(`Storage changed to ${newMachine.name}.`);
  }
  
  function renderStorageTypesList() {
    const list = $("#storageTypesList");
    if (!list) return;
    
    const storageMachines = state.db.machines.filter(m => m.kind === "storage");
    
    if (storageMachines.length === 0) {
      list.innerHTML = '<div class="emptyState">No storage machines configured.<br>Add a storage machine in the Machines tab first.</div>';
      return;
    }
    
    list.innerHTML = `
      <div class="storageTypesList">
        ${storageMachines.map(machine => `
          <div class="storageTypeItem" data-storage-machine-id="${machine.id}">
            <div class="storageTypeItem__name">${escapeHtml(machine.name)}</div>
            <div class="storageTypeItem__meta">${machine.storageSlots} slots • ${machine.inputs} in • ${machine.outputs} out</div>
          </div>
        `).join("")}
      </div>
    `;
  }
  
  function renderSkillsList() {
    const list = $("#skillsList");
    if (!list) return;
    
    const skills = [
      {
        id: "conveyorSpeed",
        name: "Conveyor Speed",
        description: "Each point adds +15/min to conveyor speed (base 60/min)",
        value: state.skills.conveyorSpeed,
      },
      {
        id: "throwingSpeed",
        name: "Throwing Speed",
        description: "Each point adds +15/min to throwing speed (base 60/min)",
        value: state.skills.throwingSpeed,
      },
      {
        id: "machineEfficiency",
        name: "Machine Efficiency",
        description: "Each point reduces recipe processing time by 25% and increases fuel consumption by 25%",
        value: state.skills.machineEfficiency,
      },
      {
        id: "alchemyEfficiency",
        name: "Alchemy Efficiency",
        description: "Each point adds +3% to Extractor output (extractors convert solid to liquid)",
        value: state.skills.alchemyEfficiency,
      },
      {
        id: "fuelEfficiency",
        name: "Fuel Efficiency",
        description: "Each point adds +10% to fuel consumption rate",
        value: state.skills.fuelEfficiency,
      },
      {
        id: "fertilizerEfficiency",
        name: "Fertilizer Efficiency",
        description: "Each point adds +10% to fertilizer value",
        value: state.skills.fertilizerEfficiency,
      },
      {
        id: "shopProfit",
        name: "Shop Profit",
        description: "Each point adds +3% to shop profit",
        value: state.skills.shopProfit,
      },
    ];
    
    list.innerHTML = skills.map(skill => `
      <div class="skillItem">
        <div class="skillItem__info">
          <div class="skillItem__name">${escapeHtml(skill.name)}</div>
          <div class="skillItem__description">${escapeHtml(skill.description)}</div>
        </div>
        <input 
          type="number" 
          class="skillItem__input" 
          data-skill="${skill.id}" 
          value="${skill.value}" 
          min="0" 
          max="10"
        />
      </div>
    `).join("");
  }
  
  function saveSkillsFromDialog() {
    const inputs = $$("[data-skill]");
    inputs.forEach(input => {
      const skillId = input.dataset.skill;
      const value = parseInt(input.value) || 0;
      if (state.skills.hasOwnProperty(skillId)) {
        state.skills[skillId] = Math.max(0, Math.min(10, value));
      }
    });
    
    saveSkills();
    closeDialog();
    renderSkillsBar(); // Update skills bar
    renderCanvas(); // Re-render canvas to apply skill effects
    setStatus("Skills updated.");
  }
  
  function init() {
    state.db = loadDb();
    const buildData = loadBuild();
    state.build.placedMachines = buildData.placedMachines;
    state.build.connections = buildData.connections;
    state.build.camera = buildData.camera;
    state.skills = loadSkills();
    
    // Load UI preferences (sidebar states)
    const uiPrefs = loadUIPrefs();
    state.ui.sidebars = uiPrefs.sidebars;
    
    // Apply sidebar visibility based on loaded preferences
    if (state.ui.sidebars.database) {
      $("#databaseSidebar")?.classList.remove("hidden");
    } else {
      $("#databaseSidebar")?.classList.add("hidden");
    }
    
    if (state.ui.sidebars.blueprints) {
      $("#blueprintsSidebar")?.classList.remove("hidden");
    } else {
      $("#blueprintsSidebar")?.classList.add("hidden");
    }
    
    if (state.ui.sidebars.production) {
      $("#productionSidebar")?.classList.remove("hidden");
    } else {
      $("#productionSidebar")?.classList.add("hidden");
    }
    
    wireMenus();
    wireTabs();
    wireSearch();
    wireAddButtons();
    wireListsAndForms();
    wireImportInput();
    wireCanvas();

    renderAll();
    updateLayoutGridColumns(); // Set correct grid columns BEFORE rendering canvas
    renderCanvas(); // Now render with correct dimensions
    
    // Render production summary if sidebar is open
    if (state.ui.sidebars.production) {
      renderProductionSummary();
    }
    
    // Ensure camera transform is applied after layout settles
    setTimeout(() => updateCameraTransform(), 0);
    
    setStatus("Ready.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ---------- Types (JSDoc) ----------
  /**
   * @typedef {{
   *  version: number,
   *  meta: { createdAt: string, updatedAt: string },
   *  materials: Array<Material>,
   *  machines: Array<Machine>,
   *  recipes: Array<Recipe>,
   * }} Db
   */
  /**
   * @typedef {{
   *  id: string,
   *  name: string,
   *  buyPrice: number|null,
   *  salePrice: number|null,
   *  isFuel: boolean,
   *  fuelValue: number|null,
   * }} Material
   */
  /**
   * @typedef {{
   *  id: string,
   *  name: string,
   *  inputs: number,
   *  outputs: number,
   *  requiresFurnace: boolean,
   *  heatConsumptionP: number|null,
   *  kind: "standard" | "furnace",
   *  baseHeatConsumptionP: number,
   * }} Machine
   */
  /**
   * @typedef {{ materialId: string, items: number }} RecipeIO
   */
  /**
   * @typedef {{
   *  id: string,
   *  name: string,
   *  machineId: string,
   *  inputs: Array<RecipeIO>,
   *  outputs: Array<RecipeIO>,
   *  processingTimeSec: number,
   *  heatConsumptionP: number|null,
   * }} Recipe
   */
  /**
   * @typedef {{
   *  db: Db,
   *  ui: {
   *    activeTab: "materials"|"machines",
   *    selected: { materials: string|null, machines: string|null },
   *    filters: { materials: string, machines: string },
   *    statusTimer: number|null,
   *  }
   * }} AppState
   */
})();

