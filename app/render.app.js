/// <reference path="shared.app.js" />

// Render Layer, responsible for CANVAS rendering only.
// UI Element  rendering is handled by the UI layer.

(function () {
  "use strict";

  /** @type {AF} */
  const AF = (window.AF = window.AF || {});
  AF.render = AF.render || {};


  // Init hook called by app.js after state is loaded.
  // Keep side-effect free at file-load time; do setup here instead.
  function init() {
    // No-op for now (reserved for future internal setup).
  }


  /**
   * Update canvas subtitle/buttons during blueprint edit mode
   * (Moved from app.js so render layer owns DOM updates)
   */
  function updateBlueprintEditUI() {
    const subtitle = $("#canvasSubtitle");
    if (!subtitle) return;
    
    if (AF.state.currentBlueprintEdit) {
      const detached = AF.state.currentBlueprintEdit.detached || false;
      const forceSaveAsNew = !!AF.state.currentBlueprintEdit.forceSaveAsNew;
      const blueprint = AF.state.currentBlueprintEdit.blueprintId
        ? AF.state.db.blueprints.find(bp => bp.id === AF.state.currentBlueprintEdit.blueprintId)
        : null;
      const blueprintName = blueprint ? blueprint.name : (detached ? "Detached Blueprint" : "Unknown");
      const depth = AF.state.blueprintEditStack.length;
      
      // Different buttons based on edit mode
      const saveButtons = forceSaveAsNew
        ? `<button class="btn btn--sm" data-action="blueprint:save-edit" title="Save as a new blueprint copy">💾 Save Copy</button>`
        : detached
          ? `<button class="btn btn--sm" data-action="blueprint:save-to-instance" title="Save changes to this instance only">💾 Save to Instance</button>`
          : `<button class="btn btn--sm" data-action="blueprint:save-edit" title="Save to blueprint (updates all instances)">💾 Save to Blueprint</button>
             <button class="btn btn--sm" data-action="blueprint:save-to-instance" title="Save to instance only (detaches from blueprint)">📌 Save to Instance Only</button>`;
      
      subtitle.innerHTML = `
        <span style="color: var(--accent); font-weight: bold;">📐 ${forceSaveAsNew ? "EDITING COPY" : "EDITING"}: ${escapeHtml(blueprintName)}</span>
        ${detached ? `<span style="color: var(--warning);"> (DETACHED)</span>` : ""}
        ${depth > 1 ? `<span style="color: var(--muted);"> (Depth: ${depth})</span>` : ""}
        ${saveButtons}
        ${forceSaveAsNew ? "" : `<button class="btn btn--sm" data-action="blueprint:save-as-new" title="Save as new blueprint">📋 Save As New</button>`}
        <button class="btn btn--sm" data-action="blueprint:exit-edit" title="Exit without saving">❌ Exit</button>
      `;
    } else {
      // Restore normal subtitle
      const speed = AF.state.calc?.skill?.effectiveConveyorSpeed ?? 0;
      const { x: camX, y: camY, zoom } = AF.state.build.camera;
      const zoomPercent = Math.round(zoom * 100);
      subtitle.innerHTML = `Conveyor: ${speed}/min | <span class="canvas__coords" title="Click to jump to coordinates">Position: (${Math.round(camX)}, ${Math.round(camY)})</span> | Zoom: ${zoomPercent}%`;
    }
  }
  
  /**
   * Update camera transform without re-rendering (fast)
   */
  function updateCameraTransform() {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    const { x: camX, y: camY, zoom } = AF.state.build.camera;
    
    // Update subtitle (only if not in blueprint edit mode)
    if (!AF.state.currentBlueprintEdit) {
      const subtitle = $("#canvasSubtitle");
      if (subtitle) {
        const speed = AF.state.calc?.skill?.effectiveConveyorSpeed ?? 0;
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
    AF.state.build.placedMachines.forEach(pm => {
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
  // Public wrapper: schedule calc->render (do not compute here)
  function renderCanvas(forceRecreate = false) {
    AF.scheduler?.invalidate?.({ needsRecalc: true, needsRender: true, forceRecreate: !!forceRecreate });
  }

  // Implementation: pure DOM work only (called by scheduler)
  function renderCanvasImpl(forceRecreate = false) {
    const canvas = $("#designCanvas");
    if (!canvas) return;
    
    // Update canvas subtitle
    updateBlueprintEditUI();
    
    // If no machines, show placeholder
    if (AF.state.build.placedMachines.length === 0) {
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
    
    // NOTE: Calculations are performed by scheduler before rendering.
    // Rendering must be read-only and should not trigger recalculation.
    
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
    const currentMachineIds = new Set(AF.state.build.placedMachines.map(pm => pm.id));
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
      
      AF.state.build.placedMachines.forEach(pm => {
        const el = createPlacedMachineElement(pm);
        container.appendChild(el);
      });
    } else {
      // Smart update: reuse elements where possible
      AF.state.build.placedMachines.forEach(pm => {
        let el = container.querySelector(`[data-placed-machine="${pm.id}"]`);
        
        if (el) {
          // Element exists - update position
          el.style.left = `${pm.x}px`;
          el.style.top = `${pm.y}px`;
          
          // Check if we need to update content (precomputed in calculator)
          const hasInsufficientInputs = !!pm.hasInsufficientInputs;
          const shouldHaveInsufficient = el.classList.contains("has-insufficient-inputs");
          
          // Check if efficiency changed (for underclocking display)
          const currentEfficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
          const storedEfficiency = parseFloat(el.dataset.efficiency || "1.0");
          const efficiencyChanged = Math.abs(currentEfficiency - storedEfficiency) > 0.001;
          
          // Check if storage connections changed (storage machines need full redraw when connections change)
          let storageConnectionsChanged = false;
          if (pm.type === "machine" && pm.machineId) {
            const machine = AF.core.getMachineById(pm.machineId);
            if (machine && machine.kind === "storage") {
              const currentConnectionCount = 
                AF.state.build.connections.filter(c => c.fromMachineId === pm.id || c.toMachineId === pm.id).length;
              const storedConnectionCount = parseInt(el.dataset.connectionCount || "0");
              storageConnectionsChanged = currentConnectionCount !== storedConnectionCount;
            }
          }

          // Blueprint instances depend heavily on external connection state (inputs/outputs, fuel ports).
          // Recreate when connection count changes so ports/rates refresh immediately.
          let blueprintConnectionsChanged = false;
          if (pm.type === "blueprint_instance" || pm.type === "blueprint") {
            const currentConnectionCount =
              AF.state.build.connections.filter(c => c.fromMachineId === pm.id || c.toMachineId === pm.id).length;
            const storedConnectionCount = parseInt(el.dataset.connectionCount || "0");
            blueprintConnectionsChanged = currentConnectionCount !== storedConnectionCount;
          }
          
          // If state changed, recreate the element
          if (hasInsufficientInputs !== shouldHaveInsufficient || efficiencyChanged || storageConnectionsChanged || blueprintConnectionsChanged) {
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
  }

  function createPlacedMachineElement(placedMachine) {
    // Normalize old data
    const type = placedMachine.type || "machine";
    const count = placedMachine.count || 1;
    
    const isSelected = AF.state.build.selectedMachines.includes(placedMachine.id);
    const hasInsufficientInputs = !!placedMachine.hasInsufficientInputs;
    
    const el = document.createElement("div");
    const selectionCount = AF.state.build.selectedMachines.length;
    const isMultiSelect = isSelected && selectionCount > 1;
    el.className = `buildMachine${isSelected ? " is-selected" : ""}${hasInsufficientInputs ? " has-insufficient-inputs" : ""}`;
    el.dataset.placedMachine = placedMachine.id;
    
    // Store efficiency for change detection
    el.dataset.efficiency = String(placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0);
    
    // Store connection count for storage machines (for change detection)
    const connectionCount = AF.state.build.connections.filter(c => 
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
    
    // Blueprint type (both old "blueprint" and new "blueprint_instance")
    if (type === "blueprint" || type === "blueprint_instance") {
      // Support both old and new formats
      const usePhysicalModel = placedMachine.childMachines && placedMachine.childMachines.length > 0;
      
      const bpName = placedMachine.name || placedMachine.blueprintData?.name || "Unnamed Blueprint";
      const bpDescription = placedMachine.description || placedMachine.blueprintData?.description || "";
      
      let bpInputs, bpOutputs, actualMachineCount;
      
      if (usePhysicalModel) {
        // New physical instance model - calculate rates from child machines
        actualMachineCount = placedMachine.childMachines.filter(m => m.type !== "export").length;
        
        // Build inputs from port mappings - rates include child machine efficiency
        bpInputs = (placedMachine.portMappings?.inputs || []).map(mapping => {
          const childMachine = placedMachine.childMachines.find(m => m.id === mapping.internalMachineId);
          if (!childMachine) return { materialId: mapping.materialId, rate: 0, kind: mapping.kind, internalMachineId: mapping.internalMachineId, internalPortIdx: mapping.internalPortIdx };
          
          const key = `${childMachine.id}::${String(mapping.internalPortIdx)}`;
          const maxRate = AF.state.calc?.port?.inputDemand?.get(key) ?? 0;
          const childEfficiency = childMachine.efficiency !== undefined ? childMachine.efficiency : 1.0;
          const actualRate = maxRate * childEfficiency;
          return { materialId: mapping.materialId, rate: actualRate, kind: mapping.kind, internalMachineId: mapping.internalMachineId, internalPortIdx: mapping.internalPortIdx };
        });
        
        // Build outputs from port mappings.
        // Capacity-only semantics:
        // - capacity is net export capacity at 100% operation:
        //   max output (from state.calc.port.outputRate) minus any mandatory internal consumption
        //   fed from the same internal output port (e.g. self-fuel inside the blueprint).
        // - external consumption is shown separately in the UI (see outputsHTML)
        const exportChildIds = new Set(
          (placedMachine.childMachines || []).filter(m => m.type === "export").map(m => m.id)
        );
        const getInternalConsumptionForOutput = (mapping) => {
          if (!mapping || !Array.isArray(placedMachine.childConnections)) return 0;

          const seen = new Set(); // `${toId}::${toPort}` to avoid double counting identical ports
          let total = 0;

          placedMachine.childConnections.forEach(c => {
            const fromId = c._resolvedFromMachineId || c.fromMachineId;
            const fromPort = c._resolvedFromPortIdx !== undefined ? c._resolvedFromPortIdx : c.fromPortIdx;
            if (fromId !== mapping.internalMachineId) return;
            if (String(fromPort) !== String(mapping.internalPortIdx)) return;

            const toId = c._resolvedToMachineId || c.toMachineId;
            if (toId === "__virtual_sink__" || c._isVirtualSinkConnection) return;
            if (exportChildIds.has(toId)) return; // internal export sinks are optional, not mandatory consumption

            const toPort = c._resolvedToPortIdx !== undefined ? c._resolvedToPortIdx : c.toPortIdx;
            const portKey = `${toId}::${String(toPort)}`;
            if (seen.has(portKey)) return;
            seen.add(portKey);

            // Use the calculator snapshot (no calc calls from render).
            const demand = AF.state.calc?.port?.inputDemand?.get?.(portKey) ?? 0;
            if (demand > 0.0001) total += demand;
          });

          return total;
        };

        bpOutputs = (placedMachine.portMappings?.outputs || []).map(mapping => {
          const key = `${mapping.internalMachineId}::${String(mapping.internalPortIdx)}`;
          const maxRate = AF.state.calc?.port?.outputRate?.get(key) ?? 0;
          const internalConsumption = getInternalConsumptionForOutput(mapping);
          const netMax = Math.max(0, maxRate - internalConsumption);
          // For physical blueprint instances, the calculator already applies blueprint quantity (×count)
          // to internal child port rates. Don't multiply again here.
          const capacityRate = netMax;
          return {
            materialId: mapping.materialId,
            capacityRate,
            internalMachineId: mapping.internalMachineId,
            internalPortIdx: mapping.internalPortIdx,
          };
        });
      } else {
        // Old black box model (backward compatibility)
        const bpData = placedMachine.blueprintData || {};
        bpInputs = bpData.inputs || [];
        bpOutputs = bpData.outputs || [];
        const bpMachines = bpData.machines || [];
        const blueprintId = placedMachine.blueprintId;
        const machineCounts =
          (blueprintId && AF.state.calc?.blueprintMachineCounts?.get?.(blueprintId)) ??
          { totalCount: bpMachines.length, breakdown: {} };
        actualMachineCount = machineCounts.totalCount;
      }
      
      // Calculate stats from contained machines
      let hasFurnaces = false;
      let hasNurseries = false;
      let totalFuelConsumption = 0;
      let totalFertilizerProduction = 0;
      let plantOutputRate = 0;
      
      const machinesToAnalyze = usePhysicalModel 
        ? placedMachine.childMachines 
        : (placedMachine.blueprintData?.machines || []);
      
      machinesToAnalyze.forEach(machine => {
        const machineData = AF.core.getMachineById(machine.machineId);
        if (machineData) {
          if (machineData.kind === "heating_device") {
            hasFurnaces = true;
            // Prefer calculator snapshot (already includes blueprint quantity multipliers)
            const ui = AF.state.calc?.uiByMachineId?.get?.(machine.id);
            if (usePhysicalModel && ui && ui.kind === "heating_device") {
              totalFuelConsumption += Number(ui.totalHeatP) || 0;
            } else {
              // Fallback: base heat only (old model)
              let heatP = machineData.baseHeatConsumptionP || 0;
              (machine.toppers || []).forEach(topper => {
                const topperMachine = AF.core.getMachineById(topper.machineId);
                if (topperMachine) {
                  heatP += topperMachine.heatConsumptionP || 0;
                }
              });
              totalFuelConsumption += heatP;
            }
          }
          if (machineData.kind === "nursery") {
            hasNurseries = true;
            // Get plant output rate
            const key = `${machine.id}::0`;
            const outputRate = AF.state.calc?.port?.outputRate?.get(key) ?? 0;
            plantOutputRate += outputRate;
          }
        }
      });
      
      // Check if produces fertilizer
      bpOutputs.forEach(output => {
        const material = AF.core.getMaterialById(output.materialId);
        if (material && material.kind === "fertilizer") {
          const cap = usePhysicalModel ? (output.capacityRate || 0) : ((output.rate || 0) * count);
          totalFertilizerProduction += cap;
        }
      });
      
      // Get efficiency for UI display
      // Use pre-calculated efficiency from calculateMachineEfficiencies()
      // which properly excludes source machines from the minimum calculation
      const efficiency = placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0;
      
      // Build input ports HTML
      const inputsHTML = bpInputs.map((input, idx) => {
        const isFuel = input && (input.kind === "fuel" || input.materialId == null);
        const material = !isFuel ? AF.core.getMaterialById(input.materialId) : null;

        // Fuel: show heat requirement (P) in the label, and fuel items/min in the rate when connected.
        let fuelP = 0;
        if (isFuel && input.internalMachineId) {
          const ui = AF.state.calc?.uiByMachineId?.get?.(input.internalMachineId);
          if (ui && ui.kind === "heating_device") fuelP = Number(ui.totalHeatP) || 0;
        }
        if (!usePhysicalModel) fuelP *= (placedMachine.count || 1);

        const materialName = isFuel ? `Fuel (${fuelP.toFixed(1)}P)` : (material ? material.name : "Unknown");
        // For physical model, rate already includes efficiency from child machines
        // For old model, multiply by count and efficiency
        const rate = usePhysicalModel ? input.rate : (input.rate * count * efficiency);
        const rateStr = isFuel
          ? (rate > 0.01 ? `${rate.toFixed(2)}/min` : "—")
          : `${rate.toFixed(2)}/min`;
        return `
          <div class="buildPort buildPort--input" data-input-port="${idx}" title="${materialName} - ${rateStr}">
            <div class="buildPort__dot"></div>
            <div class="buildPort__label">${escapeHtml(materialName)}</div>
            <div class="buildPort__rate">${rateStr}</div>
          </div>
        `;
      }).join("");
      
      // Build output ports HTML
      const outputsHTML = bpOutputs.map((output, idx) => {
        const material = AF.core.getMaterialById(output.materialId);
        const materialName = material ? material.name : "Unknown";
        // Capacity-only (green). For old model, capacity is bpData.outputs rate * count (ignore efficiency).
        const capacity = usePhysicalModel ? (output.capacityRate || 0) : ((output.rate || 0) * count);

        // External consumption (red): sum of actual rates leaving the blueprint port.
        // Only meaningful for physical model (old model doesn't have resolved internals).
        let consumed = 0;
        if (usePhysicalModel) {
          AF.state.build.connections.forEach(c => {
            if (c.fromMachineId !== placedMachine.id) return;
            if (String(c.fromPortIdx) !== String(idx)) return;
            consumed += (c.actualRate ?? 0);
          });
        }

        const capStr = `${capacity.toFixed(2)}/min`;
        const consumedStr = `${consumed.toFixed(2)}/min`;
        const isBalanced = consumed > 0.01 && Math.abs(consumed - capacity) <= 0.01;
        return `
          <div class="buildPort buildPort--output" data-output-port="${idx}" title="${materialName} - cap ${capStr}${consumed > 0.01 ? `, consumed ${consumed.toFixed(2)}/min` : ''}">
            <div class="buildPort__label">${escapeHtml(materialName)}</div>
            <div class="buildPort__rate">
              ${
                // If capacity and demand match, show a single neutral rate (like standard cards).
                isBalanced
                  ? `${capStr}`
                  : `<span style="color: var(--ok)">${capStr}</span>` +
                    (consumed > 0.01 ? `<span style="color: var(--danger); margin-left: 6px;">-${consumedStr}</span>` : ``)
              }
            </div>
            <div class="buildPort__dot"></div>
          </div>
        `;
      }).join("");
      
      // Build stats panels
      let statsHTML = "";
      
      if (hasFurnaces) {
        const fuelConsumption = usePhysicalModel ? totalFuelConsumption : (totalFuelConsumption * count);
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
        const plantOutput = usePhysicalModel ? plantOutputRate : (plantOutputRate * count);
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
        const fertilizerProduction = usePhysicalModel ? totalFertilizerProduction : (totalFertilizerProduction * count);
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
      
      // Efficiency badge (match normal machine cards)
      const efficiencyPercent = (efficiency * 100).toFixed(1);
      const isUnderclocked = efficiency < 0.999; // Show if less than 99.9%
      const efficiencyBadge = isUnderclocked
        ? `<span style="font-size: 10px; padding: 2px 6px; background: rgba(255,165,0,0.2); border: 1px solid rgba(255,165,0,0.4); border-radius: 4px; color: #ffa500; font-weight: 600;" title="Machine is underclocked due to insufficient downstream demand">${efficiencyPercent}%</span>`
        : '';
      
      el.innerHTML = `
        <div class="buildMachine__header">
          <div class="buildMachine__title">📐 ${escapeHtml(bpName)} ${count > 1 ? `<span style="color: var(--accent);">(×${count})</span>` : ''}</div>
          ${efficiencyBadge}
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
      const conveyorSpeed = AF.state.calc?.skill?.conveyorSpeed ?? 0;
      const efficiency = placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0;
      const actualRate = conveyorSpeed * efficiency;
      const materialId = placedMachine.materialId || null;
      const material = materialId ? AF.core.getMaterialById(materialId) : null;
      
      // Calculate cost per minute based on actual rate (required export rate)
      let costStatsHTML = '';
      if (material && material.buyPrice) {
        const costPerMinute = actualRate * material.buyPrice;
        const costStr = formatCoins(costPerMinute);
        const unitCostStr = formatCoins(material.buyPrice);
        
        costStatsHTML = `
          <div class="buildMachine__stats" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">
            <div class="buildMachine__stat">
              <div class="buildMachine__statLabel">💰 Cost per Minute</div>
              <div class="buildMachine__statValue" style="color: var(--danger);">${costStr}/min</div>
            </div>
            <div class="buildMachine__stat" style="font-size: 10px; color: var(--muted); margin-top: 4px;">
              ${unitCostStr} × ${actualRate.toFixed(2)}/min
            </div>
          </div>
        `;
      }
      
      // Material selector
      const materialOptions = AF.state.db.materials.map(m => 
        `<option value="${m.id}" ${m.id === materialId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
      ).join("");
      
      const outputsHTML = `
        <div class="buildPort buildPort--output" data-output-port="0" title="${material ? material.name : 'Select material'} - ${actualRate.toFixed(2)}/min">
          <div class="buildPort__label">${material ? escapeHtml(material.name) : 'Select'}</div>
          <div class="buildPort__rate">${actualRate.toFixed(2)}/min</div>
          <div class="buildPort__dot"></div>
        </div>
      `;
      
      // Don't show efficiency badge for purchasing portals - they scale to downstream demand
      // Their "efficiency" value is not a bottleneck indicator, just a demand indicator
      
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
          <div class="hint" style="margin-top: 6px;">
            Max: ${conveyorSpeed}/min | Actual: ${actualRate.toFixed(2)}/min
          </div>
          ${costStatsHTML}
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

    // Export node (placeable sink) - accepts any number of incoming connections (any materials)
    if (type === "export") {
      // Collect incoming connections and group by material
      const incoming = AF.state.build.connections.filter(c => c.toMachineId === placedMachine.id);
      const byMaterial = new Map(); // materialId -> totalRate

      incoming.forEach(c => {
        const fromId = c._resolvedFromMachineId || c.fromMachineId;
        const fromPortIdx = c._resolvedFromPortIdx !== undefined ? c._resolvedFromPortIdx : c.fromPortIdx;
        const key = `${fromId}::${String(fromPortIdx)}`;
        const matId = AF.state.calc?.port?.outputMaterial?.get?.(key) ?? null;
        const rate = c.actualRate ?? 0;
        if (!matId) return;
        byMaterial.set(matId, (byMaterial.get(matId) || 0) + rate);
      });

      const listHtml = byMaterial.size === 0
        ? '<div class="hint" style="margin: 0;">Connect outputs here to export surplus.</div>'
        : Array.from(byMaterial.entries())
          .sort((a, b) => {
            const ma = AF.core.getMaterialById(a[0])?.name || "";
            const mb = AF.core.getMaterialById(b[0])?.name || "";
            return ma.localeCompare(mb);
          })
          .map(([materialId, rate]) => {
            const m = AF.core.getMaterialById(materialId);
            const name = m ? m.name : materialId;
            return `
              <div class="storageInventory__item" style="padding: 8px 10px;">
                <div class="storageInventory__material">${escapeHtml(name)}</div>
                <div class="storageInventory__status">${Number(rate).toFixed(2)}/min</div>
              </div>
            `;
          }).join("");

      const totalRate = Array.from(byMaterial.values()).reduce((s, v) => s + v, 0);

      const inputsHTML = `
        <div class="buildPort buildPort--input" data-input-port="0" title="Export (multi-material)">
          <div class="buildPort__dot"></div>
          <div class="buildPort__label">Export</div>
          <div class="buildPort__rate">${Number(totalRate).toFixed(2)}/min</div>
        </div>
      `;

      el.innerHTML = `
        <div class="buildMachine__header">
          <div class="buildMachine__title">Export</div>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn--sm" data-action="build:clone-machine" title="Clone">📋</button>
            <button class="btn btn--danger btn--sm" data-action="build:delete-machine" title="Remove">✕</button>
          </div>
        </div>
        <div class="buildMachine__body">
          <div class="hint" style="margin-top: 0;">
            Acts as an infinite sink. Useful for exporting surplus in cyclical/self-fed systems.
          </div>
          <div class="storageInventory" style="margin-top: 8px;">
            <div class="storageInventory__title">Incoming (${byMaterial.size})</div>
            ${listHtml}
          </div>
        </div>
        <div class="buildMachine__ports">
          <div class="buildMachine__portGroup">
            <div class="buildMachine__portLabel">Input</div>
            ${inputsHTML}
          </div>
        </div>
      `;

      return el;
    }
    
    // Nursery type
    if (type === "nursery") {
      const plantId = placedMachine.plantId || null;
      const plant = plantId ? AF.core.getMaterialById(plantId) : null;
      
      // Get fertilizer from connected input OR selected fertilizer
      let fertilizerMaterial = null;
      let isConnected = false;
      const incomingConnections = AF.state.build.connections.filter(conn => conn.toMachineId === placedMachine.id);
      if (incomingConnections.length > 0) {
        const sourceConn = incomingConnections[0];
        const sourceMachine = AF.state.build.placedMachines.find(pm => pm.id === sourceConn.fromMachineId);
        if (sourceMachine) {
          const key = `${sourceMachine.id}::${String(sourceConn.fromPortIdx)}`;
          const fertId = AF.state.calc?.port?.outputMaterial?.get(key) ?? null;
          if (fertId) {
            fertilizerMaterial = AF.core.getMaterialById(fertId);
            isConnected = true;
          }
        }
      }
      
      // If no connection, use selected fertilizer
      if (!fertilizerMaterial && placedMachine.fertilizerId) {
        fertilizerMaterial = AF.core.getMaterialById(placedMachine.fertilizerId);
      }
      
      // Read precomputed nursery stats (calculator owns these)
      const ui = AF.state.calc?.uiByMachineId?.get?.(placedMachine.id);
      const plantOutputRate = ui && ui.kind === "nursery" ? (ui.plantOutputRate || 0) : 0;
      const fertilizerInputRate = ui && ui.kind === "nursery" ? (ui.fertilizerInputRate || 0) : 0;
      const growthTime = ui && ui.kind === "nursery" ? (ui.growthTime || 0) : 0;
      const nurseriesPerBelt = ui && ui.kind === "nursery" ? (ui.nurseriesPerBelt || 0) : 0;
      const fertilizerDuration = ui && ui.kind === "nursery" ? (ui.fertilizerDuration || 0) : 0;
      const hasNoFertilizer = ui && ui.kind === "nursery" ? !!ui.hasNoFertilizer : (!isConnected && !placedMachine.fertilizerId);
      
      // Plant selector (only show plants)
      const plantOptions = AF.state.db.materials
        .filter(m => m.isPlant)
        .map(m => `<option value="${m.id}" ${m.id === plantId ? 'selected' : ''}>${escapeHtml(m.name)} (${m.plantRequiredNutrient}V)</option>`)
        .join("");
      
      // Fertilizer selector (only show fertilizers)
      const fertilizerOptions = AF.state.db.materials
        .filter(m => m.isFertilizer)
        .map(m => {
          const v = AF.state.calc?.fertilizerValueByMaterialId?.get?.(m.id) ?? (m.fertilizerNutrientValue ?? 0);
          return `<option value="${m.id}" ${m.id === placedMachine.fertilizerId ? 'selected' : ''}>${escapeHtml(m.name)} (${v}V, ${m.fertilizerMaxFertility}V/s)</option>`;
        })
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
            ${plantId && hasNoFertilizer ? '<span class="buildMachine__warning" title="No Fertiliser selected: choose one in the dropdown or connect a fertiliser input">⚠️</span>' : ''}
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
            <strong>One belt (${AF.state.calc?.skill?.conveyorSpeed ?? 0}/min) supports ${nurseriesPerBelt} nurseries</strong>
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
    
    const machine = placedMachine.machineId ? AF.core.getMachineById(placedMachine.machineId) : null;
    
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
        const portRate = AF.state.calc?.storagePortRates?.get?.(`${placedMachine.id}::${String(idx)}`) ?? 0;
        return `
          <div class="buildPort buildPort--output" data-output-port="${idx}" title="Output ${idx + 1}${portRate > 0 ? ` - ${portRate.toFixed(2)}/min` : ''}">
            <div class="buildPort__label">Out ${idx + 1}</div>
            ${portRate > 0 ? `<div class="buildPort__rate">${portRate.toFixed(2)}/min</div>` : ''}
            <div class="buildPort__dot"></div>
          </div>
        `;
      }).join("");
      
      // Check if storage has inputs connected
      const hasInputs = AF.state.build.connections.some(
        conn => conn.toMachineId === placedMachine.id
      );
      
      // Read calculated inventories from snapshot (calculator owns the computation)
      const calculatedInventories = AF.state.calc?.storageInventories?.get?.(placedMachine.id) || [];
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
      const ui = AF.state.calc?.uiByMachineId?.get?.(placedMachine.id);
      const toppers = placedMachine.toppers || [];
      const heatingAreaWidth = machine.heatingAreaWidth || 1;
      const heatingAreaLength = machine.heatingAreaLength || 1;
      const totalArea = heatingAreaWidth * heatingAreaLength;
      
      // Calculate used area and total heat consumption
      const usedArea = ui && ui.kind === "heating_device" ? (ui.usedArea || 0) : 0;
      const totalHeatP = ui && ui.kind === "heating_device" ? (ui.totalHeatP || 0) : 0;
      
      // Render toppers list
      const toppersHTML = toppers.length > 0 ? toppers.map((topper, idx) => {
        const topperMachine = AF.core.getMachineById(topper.machineId);
        if (!topperMachine) return '';
        
        const footprintArea = (topperMachine.footprintWidth || 1) * (topperMachine.footprintLength || 1);
        const topperHeat = ui && ui.kind === "heating_device" ? (ui.topperHeatP?.[idx] ?? 0) : 0;
        
        // Get available recipes for this topper machine
        const topperRecipes = AF.state.db.recipes.filter(r => r.machineId === topper.machineId);
        const recipeOptions = topperRecipes.map(r => 
          `<option value="${r.id}" ${r.id === topper.recipeId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
        ).join("");
        
        return `
          <div class="storageInventory__item">
            <div style="display: flex; flex-direction: column; gap: 6px; flex: 1;">
              <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="flex: 1;">
                  <div class="storageInventory__material">${escapeHtml(topperMachine.name)}</div>
                  <div class="storageInventory__status">${footprintArea} tile${footprintArea > 1 ? 's' : ''} • ${Number(topperHeat).toFixed(1)}P</div>
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
      const availableToppers = AF.state.db.machines.filter(m => m.requiresFurnace);
      
      // Render ports for toppers
      let topperInputsHTML = [];
      let topperOutputsHTML = [];
      
      const groupedInputsMap = ui && ui.kind === "heating_device" ? ui.groupedInputs : null;
      const groupedOutputsMap = ui && ui.kind === "heating_device" ? ui.groupedOutputs : null;
      
      // Generate grouped input ports
      if (groupedInputsMap) for (const [materialId, data] of groupedInputsMap.entries()) {
        const material = AF.core.getMaterialById(materialId);
        const rate = data.rate.toFixed(2);
        const topperNames = [...(data.topperNames ? Array.from(data.topperNames) : [])].join(', ');
        const count = (data.topperNames ? data.topperNames.size : 0);
        
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
      if (groupedOutputsMap) for (const [materialId, data] of groupedOutputsMap.entries()) {
        const material = AF.core.getMaterialById(materialId);
        const rate = data.rate.toFixed(2);
        const topperNames = [...(data.topperNames ? Array.from(data.topperNames) : [])].join(', ');
        const count = (data.topperNames ? data.topperNames.size : 0);
        
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
      const fuelConnections = AF.state.build.connections.filter(
        conn => conn.toMachineId === placedMachine.id && conn.toPortIdx === "fuel"
      );
      const hasFuelConnection = fuelConnections.length > 0;
      
      // Fuel info display (selector when not connected, rate display when connected)
      let fuelInfoHTML = '';
      
      if (hasFuelConnection && totalHeatP > 0) {
        const status = ui && ui.kind === "heating_device" ? ui.fuelStatus : null;
        if (status && status.mode === "connected") {
          const fuelMaterial = status.fuelMaterialId ? AF.core.getMaterialById(status.fuelMaterialId) : null;
          const hasShortage = !!status.hasShortage;
          fuelInfoHTML = `
              <div style="margin-bottom: 8px; padding: 8px; background: ${hasShortage ? 'rgba(255,90,106,.1)' : 'rgba(69,212,131,.1)'}; border: 1px solid ${hasShortage ? 'rgba(255,90,106,.3)' : 'rgba(69,212,131,.3)'}; border-radius: 8px;">
                <div style="font-size: 11px; color: var(--muted); margin-bottom: 4px;">FUEL: ${escapeHtml(fuelMaterial ? fuelMaterial.name : 'Unknown')}</div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="font-size: 12px; font-weight: 600;">Required: ${Number(status.requiredRate).toFixed(2)}/min</div>
                    <div style="font-size: 12px; font-weight: 600; color: ${hasShortage ? 'var(--danger)' : 'var(--ok)'};">Incoming: ${Number(status.incomingRate).toFixed(2)}/min</div>
                  </div>
                  ${hasShortage ? `<div style="color: var(--danger); font-size: 18px;" title="Fuel shortage!">⚠️</div>` : `<div style="color: var(--ok); font-size: 18px;" title="Sufficient fuel">✓</div>`}
                </div>
                ${hasShortage ? `<div style="margin-top: 4px; font-size: 11px; color: var(--danger); font-weight: 600;">⚠️ SHORT BY ${Number(status.shortageAmount).toFixed(2)}/min</div>` : ''}
              </div>
            `;
        } else if (status && status.mode === "invalid") {
          fuelInfoHTML = `
              <div style="margin-bottom: 8px; padding: 8px; background: rgba(255,165,0,.1); border: 1px solid rgba(255,165,0,.3); border-radius: 8px;">
                <div style="font-size: 11px; color: var(--muted);">⚠️ Connected input is not a valid fuel</div>
              </div>
            `;
        }
      } else if (!hasFuelConnection && totalHeatP > 0) {
        // No fuel connection - show preview selector
        const selectedFuelId = placedMachine.previewFuelId || null;
        const selectedFuel = selectedFuelId ? AF.core.getMaterialById(selectedFuelId) : null;
        
        let fuelRateDisplay = '';
        // Calculate required fuel rate if a fuel is selected
        const status = ui && ui.kind === "heating_device" ? ui.fuelStatus : null;
        if (status && status.mode === "preview" && selectedFuel) {
          fuelRateDisplay = `Requires ${Number(status.previewRate).toFixed(2)} ${selectedFuel.name}/min`;
        }
        
        const fuelOptions = AF.state.db.materials
          .filter(m => m.isFuel)
          .map(m => {
            const p = AF.state.calc?.fuelHeatValueByMaterialId?.get?.(m.id) ?? (m.fuelValue ?? 0);
            return `<option value="${m.id}" ${m.id === selectedFuelId ? 'selected' : ''}>${escapeHtml(m.name)} (${p}P)</option>`;
          })
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
      const machineOptions = AF.state.db.machines
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
    
    const recipe = placedMachine.recipeId ? AF.core.getRecipeById(placedMachine.recipeId) : null;
    const effectiveTime = recipe
      ? (AF.state.calc?.effectiveProcessingTimeByRecipeId?.get?.(recipe.id) ?? 0)
      : 0;
    const efficiency = placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0;
    
    const inputsHTML = recipe ? recipe.inputs.map((inp, idx) => {
      const material = AF.core.getMaterialById(inp.materialId);
      const maxRate = (inp.items / effectiveTime) * 60 * count;
      // Show actual demand (considering efficiency)
      const actualRate = (maxRate * efficiency).toFixed(2);
      const maxRateStr = maxRate.toFixed(2);
      return `
        <div class="buildPort buildPort--input" data-input-port="${idx}" title="${material ? material.name : '(none)'} - ${actualRate}/min${efficiency < 0.99 ? ` (max: ${maxRateStr}/min)` : ''}">
          <div class="buildPort__dot"></div>
          <div class="buildPort__label">${material ? material.name : '?'}</div>
          <div class="buildPort__rate">${actualRate}/min</div>
        </div>
      `;
    }).join("") : '<div class="hint" style="padding: 4px 8px;">Select recipe</div>';
    
    const outputsHTML = recipe ? recipe.outputs.map((out, idx) => {
      const material = AF.core.getMaterialById(out.materialId);
      const maxRate = (out.items / effectiveTime) * 60 * count;
      // Show actual output (considering efficiency)
      const actualRate = (maxRate * efficiency).toFixed(2);
      const maxRateStr = maxRate.toFixed(2);
      return `
        <div class="buildPort buildPort--output" data-output-port="${idx}" title="${material ? material.name : '(none)'} - ${actualRate}/min${efficiency < 0.99 ? ` (max: ${maxRateStr}/min)` : ''}">
          <div class="buildPort__label">${material ? material.name : '?'}</div>
          <div class="buildPort__rate">${actualRate}/min</div>
          <div class="buildPort__dot"></div>
        </div>
      `;
    }).join("") : '<div class="hint" style="padding: 4px 8px;">Select recipe</div>';
    
    // Get recipes for this machine
    const availableRecipes = AF.state.db.recipes.filter(r => r.machineId === machine.id);
    const recipeOptions = availableRecipes.map(r => 
      `<option value="${r.id}" ${r.id === placedMachine.recipeId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
    ).join("");
    
    // efficiency already defined above for input/output rate calculations
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
  function getObstacles(excludeMachineIds = [], notches = []) {
    // Keep routed connections away from card edges.
    // This is not CSS padding; it's a routing "no-go" buffer so lines don't graze cards.
    const CLEARANCE = 28;
    const obstacles = [];

    // Index notches by machineId for quick lookup
    const notchByMachineId = new Map();
    (notches || []).forEach(n => {
      if (!n || !n.machineId) return;
      notchByMachineId.set(n.machineId, n);
    });
    
    // Use machine data directly for world coordinates
    AF.state.build.placedMachines.forEach(pm => {
      // Skip excluded machines (source/target of current connection)
      if (excludeMachineIds.includes(pm.id)) return;
      
      // Get machine element to determine size (use DOM dimensions, not transformed)
      const machineEl = document.querySelector(`[data-placed-machine="${pm.id}"]`);
      if (!machineEl) return;
      
      // Use offsetWidth/Height which gives element dimensions without transform effects
      const worldWidth = machineEl.offsetWidth;
      const worldHeight = machineEl.offsetHeight;

      const ox1 = pm.x - CLEARANCE;
      const oy1 = pm.y - CLEARANCE;
      const ox2 = pm.x + worldWidth + CLEARANCE;
      const oy2 = pm.y + worldHeight + CLEARANCE;

      const notch = notchByMachineId.get(pm.id) || null;
      if (!notch) {
        obstacles.push({ x1: ox1, y1: oy1, x2: ox2, y2: oy2 });
        return;
      }

      // Create a small "port notch" so wires can enter/exit the card at the port,
      // but all other segments still respect the no-go clearance.
      const side = notch.side; // "right" | "left"
      const cy = Number(notch.y);
      const halfH = Number.isFinite(notch.halfHeight) ? Number(notch.halfHeight) : 18;
      const extraW = Number.isFinite(notch.extraWidth) ? Number(notch.extraWidth) : 32;

      const ny1 = Math.max(oy1, cy - halfH);
      const ny2 = Math.min(oy2, cy + halfH);

      if (!(ny2 > ny1)) {
        obstacles.push({ x1: ox1, y1: oy1, x2: ox2, y2: oy2 });
        return;
      }

      if (side === "right") {
        // Notch near the right edge where the wire exits
        const nx1 = Math.max(ox1, (Number(notch.x) || ox2) - 2);
        const nx2 = Math.min(ox2, (Number(notch.x) || ox2) + extraW);

        // Left block (full height) to keep other routes away from the card
        if (nx1 > ox1 + 0.5) obstacles.push({ x1: ox1, y1: oy1, x2: nx1, y2: oy2 });
        // Right-top
        if (ny1 > oy1 + 0.5) obstacles.push({ x1: nx1, y1: oy1, x2: ox2, y2: ny1 });
        // Right-bottom
        if (oy2 > ny2 + 0.5) obstacles.push({ x1: nx1, y1: ny2, x2: ox2, y2: oy2 });
        return;
      }

      if (side === "left") {
        // Notch near the left edge where the wire enters
        const nx2 = Math.min(ox2, (Number(notch.x) || ox1) + 2);
        const nx1 = Math.max(ox1, (Number(notch.x) || ox1) - extraW);

        // Right block (full height)
        if (ox2 > nx2 + 0.5) obstacles.push({ x1: nx2, y1: oy1, x2: ox2, y2: oy2 });
        // Left-top
        if (ny1 > oy1 + 0.5) obstacles.push({ x1: ox1, y1: oy1, x2: nx2, y2: ny1 });
        // Left-bottom
        if (oy2 > ny2 + 0.5) obstacles.push({ x1: ox1, y1: ny2, x2: nx2, y2: oy2 });
        return;
      }

      // Fallback if unknown side
      obstacles.push({ x1: ox1, y1: oy1, x2: ox2, y2: oy2 });
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
  
  
  function getConnectionRate(connection) {
    return connection && typeof connection.actualRate === "number" ? connection.actualRate : 0;
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
    AF.state.build.connections.forEach(conn => {
      const fromMachine = document.querySelector(`[data-placed-machine="${conn.fromMachineId}"]`);
      const toMachine = document.querySelector(`[data-placed-machine="${conn.toMachineId}"]`);
      
      if (!fromMachine || !toMachine) return;
      
      const fromPort = fromMachine.querySelector(`[data-output-port="${conn.fromPortIdx}"]`);
      const toPort = toMachine.querySelector(`[data-input-port="${conn.toPortIdx}"]`);
      
      if (!fromPort || !toPort) return;
      
      // Get machine data for world coordinates
      const fromMachineData = AF.state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
      const toMachineData = AF.state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
      
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
      
      // Cards should always be treated as obstacles (with clearance),
      // except for a small "notch" at the specific ports for entry/exit.
      const obstacles = getObstacles([], [
        {
          machineId: conn.fromMachineId,
          side: "right",
          x: x1,
          y: y1,
          halfHeight: (fromPort.offsetHeight / 2) + 10,
          extraWidth: 28 + 16 + 28, // clearance + buffer + extra
        },
        {
          machineId: conn.toMachineId,
          side: "left",
          x: x2,
          y: y2,
          halfHeight: (toPort.offsetHeight / 2) + 10,
          extraWidth: 28 + 16 + 28,
        },
      ]);
      
      const path = findPath(x1, y1, x2, y2, obstacles, fromCardRight, toCardLeft);
      
      // Create polyline from path points
      const points = path.map(p => `${p.x},${p.y}`).join(" ");
      const polyline = document.createElementNS(svgNS, "polyline");
      polyline.setAttribute("points", points);
      polyline.setAttribute("fill", "none");
      polyline.setAttribute("data-connection-id", conn.id);
      polyline.style.cursor = "pointer";
      polyline.style.pointerEvents = "auto"; // Enable clicks on polyline
      polyline.style.strokeLinejoin = "round"; // Smoother corners
      polyline.style.strokeLinecap = "round";
      
      // Make it easier to click:
      // - Use a SOLID (non-dashed) invisible stroke so the dash gaps don't create click-through holes
      polyline.setAttribute("stroke-width", "10");
      
      // Create visible stroke on top
      const visiblePolyline = document.createElementNS(svgNS, "polyline");
      visiblePolyline.setAttribute("points", points);
      visiblePolyline.setAttribute("fill", "none");
      visiblePolyline.setAttribute("stroke-dasharray", "5,5");
      visiblePolyline.style.pointerEvents = "none";
      visiblePolyline.style.strokeLinejoin = "round";
      visiblePolyline.style.strokeLinecap = "round";
      
      // Check if connection is insufficient
      const sourcePlacedMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.fromMachineId);
      const targetPlacedMachine = AF.state.build.placedMachines.find(pm => pm.id === conn.toMachineId);
      const connectionRate = getConnectionRate(conn);
      // Determine target max demand. For blueprints, the rendered port is an external index,
      // but the demand snapshot is stored on the resolved internal child port.
      let targetMaxDemand = 0;
      let resolvedTargetForDemand = null;
      if (targetPlacedMachine) {
        let demandKey = `${targetPlacedMachine.id}::${String(conn.toPortIdx)}`;
        if ((targetPlacedMachine.type === "blueprint" || targetPlacedMachine.type === "blueprint_instance") && targetPlacedMachine.portMappings) {
          const portIdxNum = parseInt(conn.toPortIdx);
          const mapping = Number.isFinite(portIdxNum) ? targetPlacedMachine.portMappings.inputs?.[portIdxNum] : null;
          if (mapping && mapping.internalMachineId) {
            demandKey = `${mapping.internalMachineId}::${String(mapping.internalPortIdx)}`;
            resolvedTargetForDemand = AF.core.findMachineInTree(mapping.internalMachineId);
          }
        }
        targetMaxDemand = AF.state.calc?.port?.inputDemand?.get(demandKey) ?? 0;
      }
      
      // Calculate ACTUAL demand based on target machine's efficiency
      const effSource = resolvedTargetForDemand || targetPlacedMachine;
      const targetEfficiency = effSource && effSource.efficiency !== undefined ? effSource.efficiency : 1.0;
      const targetDemand = targetMaxDemand * targetEfficiency;
      
      // Check if insufficient: get ALL connections to this same input port
      // IMPORTANT: Storage machines don't have "demand" - their input "demand" is just a capacity cap
      // so we should never mark storage connections as insufficient
      let isInsufficient = false;
      if (targetDemand > 0 && targetPlacedMachine) {
        const targetMachineData = AF.core.getMachineById(targetPlacedMachine.machineId);
        const isTargetStorage = targetMachineData && targetMachineData.kind === "storage";
        
        // Only check insufficiency for non-storage machines
        if (!isTargetStorage) {
          const allIncomingToPort = AF.state.build.connections.filter(
            c => c.toMachineId === conn.toMachineId && c.toPortIdx === conn.toPortIdx
          );
          const totalIncoming = allIncomingToPort.reduce((sum, c) => sum + getConnectionRate(c), 0);
          isInsufficient = totalIncoming < targetDemand - 0.01;
        }
      }
      
      // Check for material type mismatch
      let isMaterialMismatch = false;
      if (sourcePlacedMachine && targetPlacedMachine) {
        const outputKey = `${sourcePlacedMachine.id}::${String(conn.fromPortIdx)}`;
        const inputKey = `${targetPlacedMachine.id}::${String(conn.toPortIdx)}`;
        // Prefer snapshot, but fall back to core mapping (required for blueprint external ports).
        const outputMaterialId =
          (AF.state.calc?.port?.outputMaterial?.get(outputKey) ?? null) ??
          (AF.core.getMaterialIdFromPort?.(sourcePlacedMachine, conn.fromPortIdx, "output") ?? null);
        const inputMaterialId =
          (AF.state.calc?.port?.inputMaterial?.get(inputKey) ?? null) ??
          (AF.core.getMaterialIdFromPort?.(targetPlacedMachine, conn.toPortIdx, "input") ?? null);
        if (outputMaterialId && inputMaterialId && outputMaterialId !== inputMaterialId) {
          isMaterialMismatch = true;
        }
      }
      
      // Style based on selection state, material mismatch, and sufficiency
      const isSelected = AF.state.build.selectedConnection === conn.id;
      polyline.setAttribute("stroke", "transparent");
      
      let lineColor = "#5aa2ff"; // Default blue
      if (isSelected) {
        lineColor = "#45d483"; // Green when selected
      } else if (isMaterialMismatch) {
        lineColor = "#ff0066"; // Bright pink/magenta for material mismatch (critical error)
      } else if (isInsufficient) {
        lineColor = "#ff5a6a"; // Red when insufficient
      }
      
      visiblePolyline.setAttribute("stroke", lineColor);
      visiblePolyline.setAttribute("stroke-width", isSelected ? "3" : "2");
      
      svgEl.appendChild(polyline);
      svgEl.appendChild(visiblePolyline);
      
      // Add connection info label (material, rate, direction)
      if (sourcePlacedMachine) {
        const materialKey = `${sourcePlacedMachine.id}::${String(conn.fromPortIdx)}`;
        const materialId =
          (AF.state.calc?.port?.outputMaterial?.get(materialKey) ?? null) ??
          (AF.core.getMaterialIdFromPort?.(sourcePlacedMachine, conn.fromPortIdx, "output") ?? null);
        const material = materialId ? AF.core.getMaterialById(materialId) : null;
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
          const beltSpeed = AF.state.calc?.skill?.conveyorSpeed ?? 0;
          const conveyorsNeeded = beltSpeed > 0.0001 ? Math.ceil(rate / beltSpeed) : 1;
          
          // Build label text
          let labelText = `${material.name} ${arrow} ${rate.toFixed(2)}/min (${conveyorsNeeded}x)`;
          if (isMaterialMismatch) {
            const inputKey = targetPlacedMachine ? `${targetPlacedMachine.id}::${String(conn.toPortIdx)}` : null;
            const inputMaterialId = inputKey ? (AF.state.calc?.port?.inputMaterial?.get(inputKey) ?? null) : null;
            const inputMaterial = inputMaterialId ? AF.core.getMaterialById(inputMaterialId) : null;
            const inputName = inputMaterial ? inputMaterial.name : "Unknown";
            labelText = `❌ MISMATCH: ${material.name} → needs ${inputName}`;
          } else if (isInsufficient && targetDemand > 0) {
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
    if (AF.state.ui.dragState && AF.state.ui.dragState.type === "connection" && AF.state.ui.dragState.currentX) {
      const x1 = AF.state.ui.dragState.startX;
      const y1 = AF.state.ui.dragState.startY;
      const x2 = AF.state.ui.dragState.currentX;
      const y2 = AF.state.ui.dragState.currentY;
      
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

  // Export render entrypoints used by scheduler/UI
  Object.assign(AF.render, {
    init,
    renderCanvas,
    renderCanvasImpl,
    updateCameraTransform,
    syncRenderAfterCameraMove,
    renderConnections
  });
})();

