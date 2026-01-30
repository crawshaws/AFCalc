/// <reference path="shared.app.js" />

(function () {
  "use strict";

  /** @type {AF} */
  const AF = (window.AF = window.AF || {});
  /** @type {AFCalc} */
  AF.calculator = (AF.calculator || {});
  


  // Init hook called by app.js after state is loaded.
  // Keep side-effect free at file-load time; do setup here instead.
  function init() {
    // Ensure caches exist
    if (!AF.state.blueprintMachineCountCache) AF.state.blueprintMachineCountCache = {};
  }

  // Calculator-owned connection rate accessor.
  // Render must not compute rates; it simply reads `connection.actualRate`.
  /**
   * Get the rate of a connection
   * @param {Connection} connection
   * @returns {number}
   */
  function getConnectionRate(connection) {
    return connection && typeof connection.actualRate === "number" ? connection.actualRate : 0;
  }

  // Skill-derived helpers (moved from app.js so calculator can snapshot them).
  function getConveyorSpeedCalc() {
    return AF.consts.CONVEYOR_SPEED + (AF.state.skills.conveyorSpeed * 15);
  }
  function getEffectiveConveyorSpeedCalc() {
    return getConveyorSpeedCalc();
  }
  function getFuelConsumptionRateCalc(baseConsumptionP) {
    return baseConsumptionP * (1 + (0.25 * AF.state.skills.machineEfficiency));
  }
  function getFuelHeatValueCalc(totalBaseP) {
    return totalBaseP * (1 + (0.10 * AF.state.skills.fuelEfficiency));
  }
  function getFertilizerValueCalc(totalBaseV) {
    return totalBaseV * (1 + (0.10 * AF.state.skills.fertilizerEfficiency));
  }
  function getEffectiveProcessingTimeCalc(baseTimeInSec) {
    const reduction = AF.state.skills.machineEfficiency * 0.25;
    return baseTimeInSec * (1 - Math.min(reduction, 1));
  }

  /**
   * Calculate storage inventory state for a placed storage machine
   * @param {PlacedMachine} placedStorage - The placed storage machine
   * @returns {Array<InventoryItem>} Array of inventory items with fill time calculations
   */
  function calculateStorageInventory(placedStorage) {
    const machine = AF.core.getMachineById(placedStorage.machineId);
    if (!machine || machine.kind !== "storage") return [];
    
    const maxSlots = placedStorage.storageSlots || machine.storageSlots;
    
    // Calculate input rates per material
    const allConnections = AF.core.getAllConnectionsInTree();
    const incomingConnections = allConnections.filter(conn => {
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      return toId === placedStorage.id;
    });
    
    // If no inputs connected, return manual inventories (if any)
    if (incomingConnections.length === 0) {
      const manualInventories = placedStorage.manualInventories || [];
      
      // Get output connections to calculate drain rate
      const outgoingConnections = allConnections.filter(conn => {
        const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
        return fromId === placedStorage.id;
      });
      
      // Build a map of material -> output rate
      const outputRates = new Map();
      outgoingConnections.forEach(conn => {
        const toId = conn._resolvedToMachineId || conn.toMachineId;
        const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
        const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
        const destMachine = AF.core.findMachineInTree(toId);
        if (!destMachine) return;
        
        // Get the material flowing through this connection from storage's perspective
        const connectionMaterialId = AF.core.getMaterialIdFromPort(placedStorage, fromPort, "output");
        if (!connectionMaterialId) return;
        
        // Get the rate this connection is demanding
        const rate = getPortInputDemand(destMachine, toPort);
        if (rate > 0) {
          outputRates.set(connectionMaterialId, (outputRates.get(connectionMaterialId) || 0) + rate);
        }
      });
      
      return manualInventories.map(inv => {
        const material = AF.core.getMaterialById(inv.materialId);
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
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
      const sourceMachine = AF.core.findMachineInTree(fromId);
      if (!sourceMachine) return;
      
      // Determine material from source port
      const materialId = AF.core.getMaterialIdFromPort(sourceMachine, fromPort, "output");
      if (!materialId) return;
      
      // Use actual connection rate (accounts for split outputs)
      const rate = getConnectionRate(conn);
      
      if (!materialFlows.has(materialId)) {
        materialFlows.set(materialId, { inputRate: 0, outputRate: 0 });
      }
      materialFlows.get(materialId).inputRate += rate;
    });
    
    // Calculate output rates per material based on downstream demand
    const outgoingConnections = allConnections.filter(conn => {
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      return fromId === placedStorage.id;
    });
    
    // For each outgoing connection, determine which material it's consuming
    outgoingConnections.forEach(conn => {
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
      const destMachine = AF.core.findMachineInTree(toId);
      if (!destMachine) return;
      
      const materialId = AF.core.getMaterialIdFromPort(destMachine, toPort, "input");
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
      const material = AF.core.getMaterialById(materialId);
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

  /**
   * Calculate rate distribution for all connections from a single output port.
   * (Moved from render layer; calculator owns all flow math.)
   *
   * @param {object} sourceMachine
   * @param {string|number} fromPortIdx
   * @param {number} totalAvailable
   * @param {Map<string, Array<object>> | null} outputConnectionsMap
   * @returns {Map<string, number>} connectionId -> rate
   */
  function distributeOutputRate(sourceMachine, fromPortIdx, totalAvailable, outputConnectionsMap = null) {
    // Get connections for this machine's port
    let siblingConnections;
    
    if (outputConnectionsMap) {
      // Use provided connections (includes virtual sink)
      const allConns = outputConnectionsMap.get(sourceMachine.id) || [];
      siblingConnections = allConns.filter(conn => {
        const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
        return String(fromPort) === String(fromPortIdx);
      });
    } else {
      // Fall back to real connections only
      const allConnections = AF.core.getAllConnectionsInTree();
      siblingConnections = allConnections.filter(
        conn => {
          const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
          const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
          return fromId === sourceMachine.id && String(fromPort) === String(fromPortIdx);
        }
      );
    }
    
    if (siblingConnections.length === 0) return new Map();
    
    const beltSpeed = getConveyorSpeed();
    const distribution = new Map(); // connectionId -> rate
    
    // Build demand info for each connection
    const connectionInfo = siblingConnections.map(conn => {
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      const toPortIdx = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
      
      // Virtual sink has infinite demand, but must be treated as a LAST-RESORT sink
      // (never steal flow from finite-demand consumers when supply is limited).
      if (conn._isVirtualSinkConnection || toId === "__virtual_sink__") {
        return {
          conn,
          maxDemand: Infinity,
          currentRate: 0,
          satisfied: false,
          isSink: true
        };
      }
      
      const target = AF.core.findMachineInTree(toId);
      if (!target) {
        return { conn, maxDemand: 0, currentRate: 0, satisfied: true };
      }

      // Placeable export node acts as an infinite sink (like virtual sink), but must also be last-resort.
      if (target.type === "export") {
        // IMPORTANT:
        // Export nodes *inside* a blueprint container are only blueprint metadata and must NOT
        // participate in live factory flow/demand. Only top-level (main canvas) Export nodes
        // behave as infinite sinks.
        if (target._isChildMachine) {
          return { conn, maxDemand: 0, currentRate: 0, satisfied: true, isSink: false };
        }
        return {
          conn,
          maxDemand: Infinity,
          currentRate: 0,
          satisfied: false,
          isSink: true
        };
      }
      
      const targetMachineData = target.machineId ? AF.core.getMachineById(target.machineId) : null;
      const isStorage = targetMachineData && targetMachineData.kind === "storage";
      const targetEfficiency = target.efficiency !== undefined ? target.efficiency : 1.0;
      
      let maxDemand = getPortInputDemand(target, toPortIdx) * targetEfficiency;
      
      // Belt speed cap ONLY for storage inputs
      if (isStorage) {
        maxDemand = Math.min(maxDemand, beltSpeed);
      }
      
      return {
        conn,
        maxDemand,
        currentRate: 0,
        satisfied: false,
        isSink: false
      };
    });
    
    function allocateFairly(infos, remaining) {
      let changed = true;
      const maxIterations = 10;
      let iteration = 0;
      
      // Iterative redistribution (equal share among unsatisfied until demands met)
      while (remaining > 0.01 && changed && iteration < maxIterations) {
        changed = false;
        iteration++;
        
        const unsatisfied = infos.filter(info => !info.satisfied);
        if (unsatisfied.length === 0) break;
        
        const share = remaining / unsatisfied.length;
        
        unsatisfied.forEach(info => {
          const additionalCapacity = Math.min(share, info.maxDemand - info.currentRate);
          
          if (additionalCapacity > 0.01) {
            info.currentRate += additionalCapacity;
            remaining -= additionalCapacity;
            changed = true;
            
            if (info.currentRate >= info.maxDemand - 0.01) {
              info.satisfied = true;
            }
          } else {
            info.satisfied = true;
          }
        });
      }
      
      return remaining;
    }
    
    // Phase 1: satisfy finite-demand consumers first (never let sinks steal scarce flow)
    let remaining = totalAvailable;
    const primary = connectionInfo.filter(info => !info.isSink);
    const sinks = connectionInfo.filter(info => info.isSink);
    
    remaining = allocateFairly(primary, remaining);
    
    // Phase 2: send any leftover to sinks (export / virtual sink)
    if (remaining > 0.01 && sinks.length > 0) {
      // If multiple sinks exist, prefer "external" sinks (top-level Export nodes or the virtual sink)
      // over internal Export nodes inside blueprints. Otherwise we can end up splitting the surplus
      // between internal+external sinks, which breaks exploded-vs-blueprinted parity.
      const preferred = sinks.filter(info => {
        const toId = info.conn._resolvedToMachineId || info.conn.toMachineId;
        if (toId === "__virtual_sink__" || info.conn._isVirtualSinkConnection) return true;
        const target = AF.core.findMachineInTree(toId);
        if (!target) return false;
        if (target.type !== "export") return false;
        // Blueprint child export nodes are secondary sinks.
        return !target._isChildMachine;
      });

      const sinkSet = preferred.length > 0 ? preferred : sinks;
      const share = remaining / sinkSet.length;
      sinkSet.forEach(info => { info.currentRate += share; });
      remaining = 0;
    }
    
    // Build result map
    connectionInfo.forEach(info => {
      distribution.set(info.conn.id, info.currentRate);
    });
    
    return distribution;
  }
  
  function calculateProductionFlow(selectedMachineIds = null) {
    // Build a map of production rates for each placed machine
    // If selectedMachineIds is provided, only calculate for those machines (for blueprint analysis)
    const productionRates = new Map(); // machineId -> { inputs: [{materialId, rate}], outputs: [{materialId, rate}] }
    
    // Get all machines including child machines from blueprints
    const allMachines = AF.core.getAllMachinesInTree();
    const allConnections = AF.core.getAllConnectionsInTree();
    const machinesToAnalyze = selectedMachineIds 
      ? allMachines.filter(pm => selectedMachineIds.includes(pm.id))
      : allMachines;
    
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
      } else if (pm.type === "nursery") {
        // Nursery outputs plants and requires fertilizer
        const efficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
        const plantRate = getPortOutputRate(pm, 0) * efficiency;
        const fertilizerRate = getPortInputDemand(pm, 0) * efficiency;
        
        // Get fertilizer material ID from connection or selection
        let fertilizerMaterialId = null;
        const incomingConn = allConnections.find(conn => {
          const toId = conn._resolvedToMachineId || conn.toMachineId;
          return toId === pm.id;
        });
        if (incomingConn) {
          const fromId = incomingConn._resolvedFromMachineId || incomingConn.fromMachineId;
          const fromPort = incomingConn._resolvedFromPortIdx !== undefined ? incomingConn._resolvedFromPortIdx : incomingConn.fromPortIdx;
          const sourceMachine = AF.core.findMachineInTree(fromId);
          if (sourceMachine) {
            fertilizerMaterialId = AF.core.getMaterialIdFromPort(sourceMachine, fromPort, "output");
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
      } else if (pm.type === "machine" && pm.machineId) {
        const machine = AF.core.getMachineById(pm.machineId);
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
          const countMultiplier = AF.state.calc?.countMultiplierByMachineId?.get?.(pm.id) ?? 1;
          const count = (pm.count || 1) * countMultiplier;
          const efficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
          const inputs = [];
          const outputs = [];
          
          // Add fuel as input (connection OR preview fuel)
          const fuelDemand = getPortInputDemand(pm, "fuel");
          if (fuelDemand > 0) {
            // Prefer real connection material, else preview fuel
            const fuelConn = allConnections.find(conn => {
              const toId = conn._resolvedToMachineId || conn.toMachineId;
              const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
              return toId === pm.id && String(toPort) === "fuel";
            });
            let fuelMaterialId = null;
            if (fuelConn) {
              const fromId = fuelConn._resolvedFromMachineId || fuelConn.fromMachineId;
              const fromPort = fuelConn._resolvedFromPortIdx !== undefined ? fuelConn._resolvedFromPortIdx : fuelConn.fromPortIdx;
              const sourceMachine = AF.core.findMachineInTree(fromId);
              if (sourceMachine) {
                fuelMaterialId = AF.core.getMaterialIdFromPort(sourceMachine, fromPort, "output");
              }
            } else {
              fuelMaterialId = pm.previewFuelId || null;
            }

            if (fuelMaterialId) {
              inputs.push({
                portIdx: "fuel",
                materialId: fuelMaterialId,
                rate: fuelDemand * efficiency
              });
            }
          }
          
          // Collect inputs and outputs from all toppers
          (pm.toppers || []).forEach((topper, topperIdx) => {
            const topperRecipe = topper.recipeId ? AF.core.getRecipeById(topper.recipeId) : null;
            if (!topperRecipe) return;
            
            const effectiveTime = getEffectiveProcessingTime(topperRecipe.processingTimeSec);
            
            topperRecipe.inputs.forEach((inp, inpIdx) => {
              if (inp.materialId) {
                inputs.push({
                  portIdx: `grouped-input-${inp.materialId}`,
                  materialId: inp.materialId,
                  rate: (inp.items / effectiveTime) * 60 * count * efficiency
                });
              }
            });
            
            topperRecipe.outputs.forEach((out, outIdx) => {
              if (out.materialId) {
                outputs.push({
                  portIdx: `grouped-output-${out.materialId}`,
                  materialId: out.materialId,
                  rate: (out.items / effectiveTime) * 60 * count * efficiency
                });
              }
            });
          });
          
          productionRates.set(pm.id, { inputs, outputs });
        } else if (pm.recipeId) {
          // Regular machine with recipe
          const recipe = AF.core.getRecipeById(pm.recipeId);
          if (recipe) {
            const effectiveTime = getEffectiveProcessingTime(recipe.processingTimeSec);
            const countMultiplier = AF.state.calc?.countMultiplierByMachineId?.get?.(pm.id) ?? 1;
            const count = (pm.count || 1) * countMultiplier;
            const efficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
            
            productionRates.set(pm.id, {
              inputs: recipe.inputs.map((inp, idx) => ({
                portIdx: idx,
                materialId: inp.materialId,
                rate: (inp.items / effectiveTime) * 60 * count * efficiency,
              })),
              outputs: recipe.outputs.map((out, idx) => ({
                portIdx: idx,
                materialId: out.materialId,
                rate: (out.items / effectiveTime) * 60 * count * efficiency,
              })),
            });
          }
        }
      }
    });
    
    return productionRates;
  }
  
  function findSourceMachines() {
    // Find all machines with no input connections (starting points) that are actually producing
    // Use all machines in tree (including blueprint children) for transparent blueprint architecture
    const allMachines = AF.core.getAllMachinesInTree();
    const allConnections = AF.core.getAllConnectionsInTree();
    
    const machinesWithInputs = new Set();
    const machinesWithOutputs = new Set();
    
    allConnections.forEach(conn => {
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      machinesWithInputs.add(toId);
      machinesWithOutputs.add(fromId);
    });
    
    // Only include machines that have outputs (are actually producing to something)
    // OR are special source types (purchasing portal, nursery)
    return allMachines.filter(pm => {
      if (machinesWithInputs.has(pm.id)) return false; // Has inputs, not a source
      
      // Must have outputs OR be a special source type
      const hasOutputs = machinesWithOutputs.has(pm.id);
      const isSpecialSource = pm.type === "purchasing_portal" || pm.type === "nursery";
      
      return hasOutputs || isSpecialSource;
    });
  }
  
  function findSinkMachines() {
    // Find all machines with no REAL output connections (exporting to virtual sink)
    // These are machines producing materials that leave the production line
    const allMachines = AF.core.getAllMachinesInTree();
    const allConnections = AF.core.getAllConnectionsInTree();
    
    const machinesWithRealOutputs = new Set();
    
    allConnections.forEach(conn => {
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      // Ignore blueprint-internal Export nodes (metadata-only). They should not count as "real outputs".
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      const target = AF.core.findMachineInTree(toId);
      const isInternalExport = !!target && target.type === "export" && !!target._isChildMachine;
      if (!isInternalExport) machinesWithRealOutputs.add(fromId);
    });
    
    // Return machines that can produce but have no real output connections
    return allMachines.filter(pm => {
      if (machinesWithRealOutputs.has(pm.id)) return false; // Has real outputs, not exporting
      
      // Check if machine can actually produce something
      const machine = pm.machineId ? AF.core.getMachineById(pm.machineId) : null;
      if (machine && machine.kind === "storage") return false; // Storage is pass-through
      
      // Machine must be able to produce (has recipe with outputs, or is purchasing portal/nursery)
      const canProduce = pm.type === "purchasing_portal" || pm.type === "nursery" || 
                        (pm.type === "machine" && pm.recipeId) ||
                        (pm.type === "machine" && pm.toppers && pm.toppers.length > 0);
      
      return canProduce;
    });
  }

  /**
   * Calculate total machine counts for a blueprint (recursively traversing nested blueprints).
   * Cached on `state.blueprintMachineCountCache`.
   * Note: This is derived data; it belongs in the calculator layer.
   * @param {string} blueprintId
   * @returns {{ totalCount: number, breakdown: Object }}
   */
  function calculateBlueprintMachineCounts(blueprintId) {
    AF.state.blueprintMachineCountCache = AF.state.blueprintMachineCountCache || {};
    
    // Check cache first
    if (AF.state.blueprintMachineCountCache[blueprintId]) {
      return AF.state.blueprintMachineCountCache[blueprintId];
    }
    
    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintId);
    if (!blueprint) {
      return { totalCount: 0, breakdown: {} };
    }
    
    let totalCount = 0;
    const breakdown = {}; // { machineId: count }
    
    blueprint.machines.forEach(pm => {
      const count = pm.count || 1;

      // Export nodes are virtual sinks used for planning demand/surplus.
      // They should remain in the blueprint definition but should NOT count as "machines"
      // for blueprint stats/UI.
      if (pm.type === "export") {
        return;
      }
      
      if ((pm.type === "blueprint" || pm.type === "blueprint_instance") && pm.blueprintId) {
        const nestedCounts = calculateBlueprintMachineCounts(pm.blueprintId);
        totalCount += nestedCounts.totalCount * count;
        
        for (const key in nestedCounts.breakdown) {
          breakdown[key] = (breakdown[key] || 0) + (nestedCounts.breakdown[key] * count);
        }
      } else {
        totalCount += count;
        
        let machineKey;
        if (pm.type === "purchasing_portal") {
          machineKey = "purchasing_portal";
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
    AF.state.blueprintMachineCountCache[blueprintId] = result;
    return result;
  }

  /**
   * Invalidate blueprint machine count cache for a specific blueprint and all blueprints that contain it.
   * @param {string} blueprintId
   */
  function invalidateBlueprintCountCache(blueprintId) {
    AF.state.blueprintMachineCountCache = AF.state.blueprintMachineCountCache || {};
    
    delete AF.state.blueprintMachineCountCache[blueprintId];
    
    AF.state.db.blueprints.forEach(bp => {
      if (bp.machines.some(m => m.type === "blueprint" && m.blueprintId === blueprintId)) {
        invalidateBlueprintCountCache(bp.id);
      }
    });
  }
  
  /**
   * Recursively expand a blueprint to get all internal machines
   * Returns array of virtual machine instances with efficiency applied
   * @param {object} blueprintInstance - Blueprint placed machine instance from canvas
   * @param {number} blueprintEfficiency - Efficiency to apply to internal machines (0-1)
   * @returns {Array} Array of expanded machine instances
   */
  function expandBlueprintMachinesRecursively(blueprintInstance, blueprintEfficiency = 1.0) {
    if (blueprintInstance.type !== "blueprint") return [];
    
    const blueprint = AF.state.db.blueprints.find(bp => bp.id === blueprintInstance.blueprintId);
    if (!blueprint) return [];
    
    const expandedMachines = [];
    const instanceCount = blueprintInstance.count || 1;
    
    blueprint.machines.forEach(templateMachine => {
      const machineCount = (templateMachine.count || 1) * instanceCount;
      
      if (templateMachine.type === "blueprint" && templateMachine.blueprintId) {
        // Nested blueprint - recursively expand
        const nestedInstance = {
          ...templateMachine,
          count: machineCount
        };
        const nestedMachines = expandBlueprintMachinesRecursively(nestedInstance, blueprintEfficiency);
        expandedMachines.push(...nestedMachines);
      } else {
        // Regular machine - create virtual instance with applied efficiency
        const virtualMachine = {
          ...templateMachine,
          id: `${blueprintInstance.id}__${templateMachine.id}`, // Unique virtual ID
          count: machineCount,
          efficiency: blueprintEfficiency, // Apply blueprint's efficiency
          _isVirtual: true, // Mark as virtual (from inside blueprint)
          _parentBlueprintId: blueprintInstance.id // Track parent
        };
        expandedMachines.push(virtualMachine);
      }
    });
    
    return expandedMachines;
  }

  function analyzeBlueprintMachines(selectedMachineIds) {
    console.log("=== Blueprint Analysis Start ===");
    console.log("Selected machine IDs:", selectedMachineIds);

    const selectedSet = new Set(selectedMachineIds);
    const machines = AF.state.build.placedMachines.filter(pm => selectedSet.has(pm.id));
    console.log("Machines to analyze:", machines.length);

    // Export nodes are virtual sinks (infinite demand). For blueprint IO analysis we treat
    // connections going INTO an Export node as leaving the blueprint (i.e., blueprint outputs).
    // IMPORTANT: Only MAIN-CANVAS Export nodes count as sinks for IO analysis.
    // Export nodes inside blueprints are metadata-only and must not create blueprint outputs.
    const exportNodeIds = new Set(
      machines
        .filter(pm => pm.type === "export" && !pm._isChildMachine)
        .map(pm => pm.id)
    );

    // Calculate what each machine produces/consumes
    const productionRates = calculateProductionFlow(selectedMachineIds);

    // Track net flows by material
    const inputsMap = new Map(); // Materials flowing INTO the blueprint from outside
    const outputsMap = new Map(); // Materials flowing OUT of the blueprint to outside

    // Check all connections to find boundary crossings
    AF.state.build.connections.forEach(conn => {
      const fromInside = selectedSet.has(conn.fromMachineId) && !exportNodeIds.has(conn.fromMachineId);
      let toInside = selectedSet.has(conn.toMachineId);

      // Treat Export nodes as "outside" for IO purposes.
      if (toInside && exportNodeIds.has(conn.toMachineId)) {
        toInside = false;
      }

      // Skip internal connections
      if (fromInside && toInside) return;

      const rate = getConnectionRate(conn);
      if (!rate) return;

      const sourceMachine = AF.state.build.placedMachines.find(m => m.id === conn.fromMachineId);
      if (!sourceMachine) return;

      // Ignore export nodes as sources (they have no outputs).
      if (sourceMachine.type === "export") return;

      const materialId = AF.core.getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
      if (!materialId) return;

      if (!fromInside && toInside) {
        // Connection from outside TO inside = input
        inputsMap.set(materialId, (inputsMap.get(materialId) || 0) + rate);
        console.log(`Input: ${AF.core.getMaterialById(materialId)?.name} @ ${rate}/min from outside`);
      } else if (fromInside && !toInside) {
        // Connection from inside TO outside = output
        outputsMap.set(materialId, (outputsMap.get(materialId) || 0) + rate);
        console.log(`Output: ${AF.core.getMaterialById(materialId)?.name} @ ${rate}/min to outside`);
      }
    });

    // Also check for unconnected ports (these are also external inputs/outputs)
    machines.forEach(pm => {
      // Export nodes are sinks and should not contribute to blueprint IO.
      if (pm.type === "export") return;

      const rates = productionRates.get(pm.id);
      if (!rates) return;

      // Check inputs without connections
      rates.inputs.forEach(inp => {
        if (!inp.materialId) return;

        // Find incoming connections for this input
        const incomingConnections = AF.state.build.connections.filter(conn =>
          conn.toMachineId === pm.id
        );

        // Check if this specific material is being supplied
        let suppliedRate = 0;
        incomingConnections.forEach(conn => {
          const sourceMachine = AF.state.build.placedMachines.find(m => m.id === conn.fromMachineId);
          if (!sourceMachine) return;
          const connMaterialId = AF.core.getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          if (connMaterialId === inp.materialId) {
            suppliedRate += getConnectionRate(conn);
          }
        });

        // If not fully supplied, the deficit is an external input
        if (suppliedRate < inp.rate - 0.01) {
          const deficit = inp.rate - suppliedRate;
          inputsMap.set(inp.materialId, (inputsMap.get(inp.materialId) || 0) + deficit);
          console.log(`Unconnected input: ${AF.core.getMaterialById(inp.materialId)?.name} @ ${deficit}/min (deficit)`);
        }
      });

      // NOTE:
      // We intentionally do NOT treat "unconnected surplus" as a blueprint output during blueprint creation.
      // Blueprint outputs should be derived only from explicit boundary crossings (including flows into a
      // MAIN-CANVAS Export node). This avoids counting internal blueprint Export sinks or internal surplus
      // that isn't explicitly exported on the main canvas.
    });

    // Convert maps to arrays
    /** @type {Array<any>} */
    const inputs = Array.from(inputsMap.entries()).map(([materialId, rate]) => ({
      materialId,
      rate,
      kind: "material",
    }));

    const outputs = Array.from(outputsMap.entries()).map(([materialId, rate]) => ({
      materialId,
      rate,
    }));

    // Special case: heating device fuel input.
    // If a selected heating device has an unconnected fuel port, expose a blueprint input port ("Fuel")
    // so the blueprint consumer can connect a fuel source.
    machines.forEach(pm => {
      if (pm.type !== "machine" || !pm.machineId) return;
      const def = AF.core.getMachineById(pm.machineId);
      if (!def || def.kind !== "heating_device") return;

      // Only add if fuel port is disconnected (no incoming fuel connection at all)
      const hasFuelConn = AF.state.build.connections.some(c =>
        c.toMachineId === pm.id && String(c.toPortIdx) === "fuel"
      );
      if (hasFuelConn) return;

      // Calculate required total heat (P) for this heating device (skill-adjusted, includes toppers).
      const furnaceCount = pm.count || 1;
      let totalHeatP = getFuelConsumptionRate(def.baseHeatConsumptionP || 1);
      (pm.toppers || []).forEach(t => {
        const tm = AF.core.getMachineById(t.machineId);
        if (!tm) return;
        totalHeatP += getFuelConsumptionRate(tm.heatConsumptionP || 0);
      });
      totalHeatP *= furnaceCount;

      // Avoid duplicates (one fuel input per heating device)
      inputs.push({
        materialId: null,
        rate: totalHeatP, // For fuel inputs, rate represents required heat (P), not items/min
        kind: "fuel",
        internalMachineId: pm.id,
        internalPortIdx: "fuel",
      });
    });

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

  /**
   * Calculate machine efficiencies with backpressure system
   * Machines underclock based on actual downstream demand vs theoretical max output
   * This cascades upstream, reducing input requirements proportionally
   * Results are cached on connections and machine efficiency stored on placedMachine objects
   * Now fully supports blueprints using physical instance model - traverses entire tree
   */
  function recalculateAll() {
    // 0) Build blueprint quantity multipliers for child machines.
    // External connections are resolved directly to internal child machines; without accounting for
    // blueprint instance `count`, those children would behave like a single blueprint (x1).
    // Store multipliers in calc state (derived; not persisted to build).
    AF.state.calc = AF.state.calc || {};
    const countMultiplierByMachineId = new Map();
    (function traverseForCount(machines, multiplier) {
      (machines || []).forEach(pm => {
        if (!pm || !pm.id) return;
        if ((pm.type === "blueprint_instance" || pm.type === "blueprint") && pm.childMachines) {
          const next = multiplier * (pm.count || 1);
          countMultiplierByMachineId.set(pm.id, multiplier);
          traverseForCount(pm.childMachines, next);
        } else {
          countMultiplierByMachineId.set(pm.id, multiplier);
        }
      });
    })(AF.state.build.placedMachines, 1);
    AF.state.calc.countMultiplierByMachineId = countMultiplierByMachineId;

    // 1) Backpressure/underclocking + connection actual rates
    calculateMachineEfficiencies();

    // 2) Production summary snapshot (render must only read this)
    const allMachines = AF.core.getAllMachinesInTree();
    const isEmpty = allMachines.length === 0;

    AF.state.calc.lastCalculatedAt = Date.now();
    AF.state.calc.netProduction = isEmpty ? { exports: new Map(), imports: new Map() } : getNetProduction();
    AF.state.calc.sources = isEmpty ? [] : findSourceMachines();
    AF.state.calc.sinks = isEmpty ? [] : findSinkMachines();

    // Purchasing portal costs (uses calculated efficiencies)
    AF.state.calc.purchasingCosts = isEmpty ? { totalCopper: 0, breakdown: new Map() } : calculatePurchasingCosts();

    // Import costs (realised cost) derived from imports map
    const importsMap = AF.state.calc.netProduction.imports || new Map();
    let totalImportCost = 0;
    const importCosts = new Map();
    importsMap.forEach((rate, materialId) => {
      if (rate > 0.01) {
        const material = AF.core.getMaterialById(materialId);
        const realizedCost = calculateRealizedCost(materialId);
        if (material && Number.isFinite(realizedCost)) {
          const costPerMinute = rate * realizedCost;
          totalImportCost += costPerMinute;
          importCosts.set(materialId, { rate, costPerMinute, material, realizedCost });
        }
      }
    });
    AF.state.calc.importCosts = importCosts;
    AF.state.calc.totalImportCost = totalImportCost;

    const portalCost = AF.state.calc.purchasingCosts.totalCopper || 0;
    AF.state.calc.totalCost = portalCost + totalImportCost;

    // Skill/material snapshots (render must not call skill math)
    const skill = {
      conveyorSpeed: getConveyorSpeedCalc(),
      effectiveConveyorSpeed: getEffectiveConveyorSpeedCalc(),
    };
    AF.state.calc.skill = skill;

    const fuelHeatValueByMaterialId = new Map();
    const fertilizerValueByMaterialId = new Map();
    (AF.state.db.materials || []).forEach(m => {
      if (m && m.isFuel && Number.isFinite(m.fuelValue)) {
        fuelHeatValueByMaterialId.set(m.id, getFuelHeatValueCalc(m.fuelValue));
      }
      if (m && m.isFertilizer && Number.isFinite(m.fertilizerNutrientValue)) {
        fertilizerValueByMaterialId.set(m.id, getFertilizerValueCalc(m.fertilizerNutrientValue));
      }
    });
    AF.state.calc.fuelHeatValueByMaterialId = fuelHeatValueByMaterialId;
    AF.state.calc.fertilizerValueByMaterialId = fertilizerValueByMaterialId;

    const effectiveProcessingTimeByRecipeId = new Map();
    (AF.state.db.recipes || []).forEach(r => {
      if (!r || !r.id) return;
      effectiveProcessingTimeByRecipeId.set(r.id, getEffectiveProcessingTimeCalc(r.processingTimeSec || 0));
    });
    AF.state.calc.effectiveProcessingTimeByRecipeId = effectiveProcessingTimeByRecipeId;

    // Storage fill items snapshot
    const storages = AF.state.build.placedMachines.filter(pm => {
      if (!pm.machineId) return false;
      const machine = AF.core.getMachineById(pm.machineId);
      return machine && machine.kind === "storage";
    });

    const storageFillItems = [];
    const storageInventories = new Map(); // storageId -> calculated inventories array
    storages.forEach(pm => {
      const inventories = calculateStorageInventory(pm);
      storageInventories.set(pm.id, inventories);
      const machine = AF.core.getMachineById(pm.machineId);
      inventories.forEach(inv => {
        if (inv.netRate > 0.01 && inv.timeToFillMinutes !== null && isFinite(inv.timeToFillMinutes)) {
          storageFillItems.push({
            storageId: pm.id,
            storageName: machine ? machine.name : "Storage",
            materialId: inv.materialId,
            materialName: inv.materialName,
            netRate: inv.netRate,
            inputRate: inv.inputRate,
            timeToFillMinutes: inv.timeToFillMinutes,
          });
        }
      });
    });
    AF.state.calc.storageFillItems = storageFillItems;
    AF.state.calc.storageInventories = storageInventories;

    // Blueprint machine counts snapshot (render reads this; render must not call calculator)
    const blueprintMachineCounts = new Map();
    (AF.state.db.blueprints || []).forEach(bp => {
      blueprintMachineCounts.set(bp.id, calculateBlueprintMachineCounts(bp.id));
    });
    AF.state.calc.blueprintMachineCounts = blueprintMachineCounts;

    // Insufficient-inputs snapshot (render reads this; no runtime calls)
    // Persist on the placedMachine objects for cheap lookup during render.
    const insufficientMachineIds = new Set();
    AF.state.build.placedMachines.forEach(pm => {
      // Default
      pm.hasInsufficientInputs = false;
      
      // Special types that don't have "insufficient inputs" semantics
      if (pm.type === "storage") return;
      if (pm.type === "purchasing_portal") return;
      if (pm.type === "nursery") return;
      if (pm.type === "blueprint" || pm.type === "blueprint_instance") return;
      
      if (pm.type !== "machine" || !pm.recipeId) return;
      
      const machine = AF.core.getMachineById(pm.machineId);
      const recipe = AF.core.getRecipeById(pm.recipeId);
      if (!machine || !recipe) return;
      
      // Storage + heating devices are excluded
      if (machine.kind === "storage") return;
      if (machine.kind === "heating_device") return;
      
      // Incoming REAL connections only (no virtual)
      const incomingConnections = AF.state.build.connections.filter(conn => conn.toMachineId === pm.id);
      
      // Machines with no real connections are importing via virtual source → no warning
      if (incomingConnections.length === 0) return;
      
      const count = pm.count || 1;
      const efficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
      const effectiveTime = getEffectiveProcessingTime(recipe.processingTimeSec);
      
      for (const inputSpec of recipe.inputs) {
        if (!inputSpec || !inputSpec.materialId) continue;
        
        const requiredRate = (inputSpec.items / effectiveTime) * 60 * count * efficiency;
        
        // Sum actual incoming rates (connection.actualRate) that match this material
        let availableRate = 0;
        for (const conn of incomingConnections) {
          const sourceMachine = AF.state.build.placedMachines.find(m => m.id === conn.fromMachineId);
          if (!sourceMachine) continue;
          const matId = AF.core.getMaterialIdFromPort(sourceMachine, conn.fromPortIdx, "output");
          if (matId === inputSpec.materialId) {
            availableRate += getConnectionRate(conn);
          }
        }
        
        if (availableRate < requiredRate - 0.01) {
          pm.hasInsufficientInputs = true;
          insufficientMachineIds.add(pm.id);
          break;
        }
      }
    });
    AF.state.calc.insufficientMachineIds = insufficientMachineIds;

    // Storage output port rates snapshot (actual rates per output port)
    const storagePortRates = new Map(); // `${storageId}::${portIdx}` -> rate
    storages.forEach(pm => {
      const machine = AF.core.getMachineById(pm.machineId);
      const outputs = machine?.outputs ?? 0;
      for (let portIdx = 0; portIdx < outputs; portIdx++) {
        const rate = AF.core.getAllConnectionsInTree()
          .filter(c => {
            const fromId = c._resolvedFromMachineId || c.fromMachineId;
            const fromPort = c._resolvedFromPortIdx !== undefined ? c._resolvedFromPortIdx : c.fromPortIdx;
            return fromId === pm.id && String(fromPort) === String(portIdx);
          })
          .reduce((sum, c) => sum + getConnectionRate(c), 0);
        storagePortRates.set(`${pm.id}::${String(portIdx)}`, rate);
      }
    });
    AF.state.calc.storagePortRates = storagePortRates;

    // UI-facing derived snapshots for special machine types (render reads these; no per-render production math)
    const uiByMachineId = new Map(); // placedMachineId -> object

    // Nursery UI snapshot
    AF.state.build.placedMachines.forEach(pm => {
      if (pm.type !== "nursery") return;
      const count = pm.count || 1;
      const plantId = pm.plantId || null;
      const plant = plantId ? AF.core.getMaterialById(plantId) : null;

      // Resolve fertilizer from connection (preferred) or selection
      let fertilizerId = pm.fertilizerId || null;
      const incoming = AF.core.getAllConnectionsInTree().find(c => {
        const toId = c._resolvedToMachineId || c.toMachineId;
        return toId === pm.id;
      });
      if (incoming) {
        const fromId = incoming._resolvedFromMachineId || incoming.fromMachineId;
        const source = AF.core.findMachineInTree(fromId);
        if (source) {
          const fromPort = incoming._resolvedFromPortIdx !== undefined ? incoming._resolvedFromPortIdx : incoming.fromPortIdx;
          const key = `${source.id}::${String(fromPort)}`;
          const connMat = AF.state.calc?.port?.outputMaterial?.get(key) ?? null;
          if (connMat) fertilizerId = connMat;
        }
      }
      const fertilizer = fertilizerId ? AF.core.getMaterialById(fertilizerId) : null;

      let plantOutputRate = 0;
      let fertilizerInputRate = 0;
      let growthTime = 0;
      let nurseriesPerBelt = 0;
      let fertilizerDuration = 0;

      if (plant && plant.plantRequiredNutrient && fertilizer && fertilizer.fertilizerMaxFertility) {
        const Nv = plant.plantRequiredNutrient;
        const Ff = fertilizer.fertilizerMaxFertility;
        const Fv = getFertilizerValueCalc(fertilizer.fertilizerNutrientValue || 0);

        growthTime = Nv / Ff;
        const outputPerNursery = growthTime > 0 ? (60 / growthTime) : 0;
        plantOutputRate = outputPerNursery * count;

        fertilizerDuration = Fv / Ff;
        const inputPerNursery = fertilizerDuration > 0 ? (60 / fertilizerDuration) : 0;
        fertilizerInputRate = inputPerNursery * count;

        nurseriesPerBelt = inputPerNursery > 0 ? Math.floor(skill.conveyorSpeed / inputPerNursery) : 0;
      }

      uiByMachineId.set(pm.id, {
        kind: "nursery",
        plantId,
        fertilizerId,
        hasFertilizerConnection: !!incoming,
        hasFertilizerSelection: !!pm.fertilizerId,
        hasNoFertilizer: !incoming && !pm.fertilizerId,
        plantOutputRate,
        fertilizerInputRate,
        growthTime,
        nurseriesPerBelt,
        fertilizerDuration,
      });
    });

    // Heating device UI snapshot
    // Include blueprint child machines too (tree), so blueprints can display fuel requirements
    // on their special Fuel input ports.
    const allMachinesForUi = AF.core.getAllMachinesInTree();
    const allConnectionsForUi = AF.core.getAllConnectionsInTree();

    allMachinesForUi.forEach(pm => {
      if (!pm.machineId) return;
      const def = AF.core.getMachineById(pm.machineId);
      if (!def || def.kind !== "heating_device") return;

      const countMultiplier = AF.state.calc?.countMultiplierByMachineId?.get?.(pm.id) ?? 1;
      const count = (pm.count || 1) * countMultiplier;
      const utilRaw = Number(pm.efficiency);
      const utilization = Number.isFinite(utilRaw) ? Math.max(0, Math.min(1, utilRaw)) : 1;
      const toppers = pm.toppers || [];
      const totalArea = (def.heatingAreaWidth || 1) * (def.heatingAreaLength || 1);

      let usedArea = 0;
      let totalHeatP = getFuelConsumptionRateCalc(def.baseHeatConsumptionP || 1);
      const topperHeatP = [];

      const groupedInputs = new Map(); // materialId -> { rate, topperNames:Array<string> }
      const groupedOutputs = new Map();

      toppers.forEach(t => {
        const tm = AF.core.getMachineById(t.machineId);
        if (!tm) return;
        const footprintArea = (tm.footprintWidth || 1) * (tm.footprintLength || 1);
        usedArea += footprintArea;

        const heat = getFuelConsumptionRateCalc(tm.heatConsumptionP || 0);
        topperHeatP.push(heat);
        totalHeatP += heat;

        if (t.recipeId) {
          const recipe = AF.core.getRecipeById(t.recipeId);
          const effectiveTime = effectiveProcessingTimeByRecipeId.get(t.recipeId) || 0;
          if (recipe && effectiveTime > 0) {
            recipe.inputs.forEach(inp => {
              if (!inp || !inp.materialId) return;
              const rate = (inp.items / effectiveTime) * 60 * count * utilization; // per furnace count, scaled by utilization
              const entry = groupedInputs.get(inp.materialId) || { rate: 0, topperNames: new Set() };
              entry.rate += rate;
              entry.topperNames.add(tm.name);
              groupedInputs.set(inp.materialId, entry);
            });
            recipe.outputs.forEach(out => {
              if (!out || !out.materialId) return;
              const rate = (out.items / effectiveTime) * 60 * count * utilization;
              const entry = groupedOutputs.get(out.materialId) || { rate: 0, topperNames: new Set() };
              entry.rate += rate;
              entry.topperNames.add(tm.name);
              groupedOutputs.set(out.materialId, entry);
            });
          }
        }
      });

      totalHeatP *= count;

      const fuelConnections = allConnectionsForUi.filter(c => {
        const toId = c._resolvedToMachineId || c.toMachineId;
        const toPort = c._resolvedToPortIdx !== undefined ? c._resolvedToPortIdx : c.toPortIdx;
        return toId === pm.id && String(toPort) === "fuel";
      });
      const hasFuelConnection = fuelConnections.length > 0;
      const selectedFuelId = pm.previewFuelId || null;

      let fuelStatus = null;
      if (hasFuelConnection && totalHeatP > 0) {
        // Fuel burn rate should scale with the heating device's settled utilization (underclocking).
        // Keep `totalHeatP` as the 100% design heat load for display, but compute required fuel items/min
        // from the effective heat actually being consumed at the current efficiency.
        const effectiveHeatP = totalHeatP * utilization;

        const fuelConn = fuelConnections[0];
        const fromId = fuelConn._resolvedFromMachineId || fuelConn.fromMachineId;
        const fromPort = fuelConn._resolvedFromPortIdx !== undefined ? fuelConn._resolvedFromPortIdx : fuelConn.fromPortIdx;
        const source = AF.core.findMachineInTree(fromId);
        if (source) {
          // Resolve material directly (don't rely on port snapshot here)
          const fuelMaterialId = AF.core.getMaterialIdFromPort(source, fromPort, "output") ?? null;
          const fuelMat = fuelMaterialId ? AF.core.getMaterialById(fuelMaterialId) : null;
          const adjustedFuelValue = fuelMaterialId ? fuelHeatValueByMaterialId.get(fuelMaterialId) : null;

          // Only valid if the connected material is actually a fuel
          if (fuelMat && fuelMat.isFuel && adjustedFuelValue && adjustedFuelValue > 0) {
            const requiredRate = (60 * effectiveHeatP) / adjustedFuelValue;
            const incomingRate = getConnectionRate(fuelConn);
            const hasShortage = incomingRate < requiredRate - 0.01;
            fuelStatus = {
              mode: "connected",
              fuelMaterialId,
              requiredRate,
              incomingRate,
              hasShortage,
              shortageAmount: hasShortage ? (requiredRate - incomingRate) : 0,
            };
          } else {
            fuelStatus = { mode: "invalid", fuelMaterialId };
          }
        }
      } else if (!hasFuelConnection && totalHeatP > 0 && selectedFuelId) {
        const adjustedFuelValue = fuelHeatValueByMaterialId.get(selectedFuelId);
        if (adjustedFuelValue && adjustedFuelValue > 0) {
          const effectiveHeatP = totalHeatP * utilization;
          const previewRate = (60 * effectiveHeatP) / adjustedFuelValue;
          fuelStatus = { mode: "preview", selectedFuelId, previewRate };
        }
      }

      uiByMachineId.set(pm.id, {
        kind: "heating_device",
        totalArea,
        usedArea,
        totalHeatP,
        topperHeatP,
        groupedInputs,
        groupedOutputs,
        fuelStatus,
      });
    });

    AF.state.calc.uiByMachineId = uiByMachineId;

    // 3) Port snapshot (render/UI must read these instead of calling calc helpers)
    // Build a minimal set of port lookups actually needed by the current graph.
    const makePortKey = (machineId, portIdx) => `${machineId}::${String(portIdx)}`;

    const port = {
      outputRate: new Map(), // key -> max output rate (items/min) at 100% machine operation (no efficiency multiplier)
      inputDemand: new Map(), // key -> max input demand (items/min) at 100% machine operation (no efficiency multiplier)
      outputMaterial: new Map(), // key -> materialId | null
      inputMaterial: new Map(), // key -> materialId | null
    };

    // Union of top-level placed machines and all child machines (tree)
    const machineLookup = new Map();
    AF.state.build.placedMachines.forEach(pm => machineLookup.set(pm.id, pm));
    allMachines.forEach(pm => machineLookup.set(pm.id, pm));

    const outputNeeds = new Map(); // machineId -> Set(portIdx)
    const inputNeeds = new Map(); // machineId -> Set(portIdx)
    const addNeed = (map, machineId, portIdx) => {
      if (!machineId) return;
      if (!map.has(machineId)) map.set(machineId, new Set());
      map.get(machineId).add(String(portIdx));
    };

    // Any port participating in any connection needs material + rate/demand
    // IMPORTANT: Use resolved endpoints so blueprint-boundary connections contribute to the
    // correct internal child ports (e.g. blueprint port "0" -> furnace "fuel").
    AF.core.getAllConnectionsInTree().forEach(conn => {
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
      addNeed(outputNeeds, fromId, fromPort);
      addNeed(inputNeeds, toId, toPort);
    });

    // Blueprint instance cards (physical model) read internal child port rates/demands for mapped ports
    AF.state.build.placedMachines.forEach(pm => {
      if ((pm.type === "blueprint" || pm.type === "blueprint_instance") && pm.portMappings && pm.childMachines) {
        (pm.portMappings.inputs || []).forEach(mapping => {
          if (!mapping) return;
          addNeed(inputNeeds, mapping.internalMachineId, mapping.internalPortIdx);
        });
        (pm.portMappings.outputs || []).forEach(mapping => {
          if (!mapping) return;
          addNeed(outputNeeds, mapping.internalMachineId, mapping.internalPortIdx);
        });
      }
    });

    // Compute output side snapshot
    for (const [machineId, ports] of outputNeeds.entries()) {
      const pm = machineLookup.get(machineId);
      if (!pm) continue;
      for (const portIdx of ports) {
        const key = makePortKey(machineId, portIdx);
        port.outputRate.set(key, getPortOutputRate(pm, portIdx) || 0);
        port.outputMaterial.set(key, AF.core.getMaterialIdFromPort(pm, portIdx, "output") || null);
      }
    }

    // Compute input side snapshot
    for (const [machineId, ports] of inputNeeds.entries()) {
      const pm = machineLookup.get(machineId);
      if (!pm) continue;
      for (const portIdx of ports) {
        const key = makePortKey(machineId, portIdx);
        port.inputDemand.set(key, getPortInputDemand(pm, portIdx) || 0);
        port.inputMaterial.set(key, AF.core.getMaterialIdFromPort(pm, portIdx, "input") || null);
      }
    }

    AF.state.calc.port = port;
  }

  function calculateMachineEfficiencies() {
    // Get ALL machines in tree (including blueprint children)
    const allMachines = AF.core.getAllMachinesInTree();
    const allConnections = AF.core.getAllConnectionsInTree();
    
    // Reset all machine efficiencies to 100% initially
    allMachines.forEach(pm => {
      pm.efficiency = 1.0; // 100%
      pm.actualInputRates = {}; // materialId -> actual rate needed
      pm.actualOutputRates = {}; // materialId -> actual rate produced
    });
    
    // Create virtual nodes for import/export tracking
    // Virtual Sink = Infinite consumption = Measures EXPORTS from production
    // Virtual Source = Infinite supply = Measures IMPORTS to production
    const VIRTUAL_SINK_ID = "__virtual_sink__";
    const VIRTUAL_SOURCE_ID = "__virtual_source__";
    
    const virtualSink = {
      id: VIRTUAL_SINK_ID,
      type: "virtual_sink",
      efficiency: 1.0,
      _isVirtualSink: true
    };
    
    const virtualSource = {
      id: VIRTUAL_SOURCE_ID,
      type: "virtual_source",
      efficiency: 1.0,
      _isVirtualSource: true
    };
    
    // Build adjacency maps for traversal
    // All connections are already resolved to child machines where applicable
    const outputConnections = new Map(); // fromMachineId -> [connections]
    const inputConnections = new Map(); // toMachineId -> [connections]
    
    allConnections.forEach(conn => {
      // Use resolved IDs (which point to actual child machines if crossing blueprint boundary)
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      
      if (!outputConnections.has(fromId)) {
        outputConnections.set(fromId, []);
      }
      outputConnections.get(fromId).push(conn);
      
      if (!inputConnections.has(toId)) {
        inputConnections.set(toId, []);
      }
      inputConnections.get(toId).push(conn);
    });
    
    // Add virtual sink connections for machines with no outgoing connections
    // These represent EXPORTS from the production line
    allMachines.forEach(pm => {
      const hasRealOutputs = outputConnections.has(pm.id);
      if (!hasRealOutputs) {
        // Skip machines that don't actually produce anything (e.g., fuel sources without toppers)
        const canProduce = pm.type === "purchasing_portal" || pm.type === "nursery" ||
                          (pm.type === "machine" && pm.recipeId) ||
                          (pm.type === "machine" && pm.toppers && pm.toppers.length > 0);

        if (canProduce) {
          const machine = pm.machineId ? AF.core.getMachineById(pm.machineId) : null;

          // Heating devices don't have numeric output ports; they use grouped output ports by material.
          // If we attach a virtual sink to port "0", demand won't register and efficiency becomes 0.
          if (machine && machine.kind === "heating_device") {
            const outputMaterialIds = new Set();
            (pm.toppers || []).forEach(t => {
              if (!t.recipeId) return;
              const r = AF.core.getRecipeById(t.recipeId);
              if (!r) return;
              (r.outputs || []).forEach(out => {
                if (out && out.materialId) outputMaterialIds.add(out.materialId);
              });
            });

            outputMaterialIds.forEach(materialId => {
              const virtualConn = {
                id: `virtual_sink_conn_${pm.id}_${materialId}`,
                fromMachineId: pm.id,
                toMachineId: VIRTUAL_SINK_ID,
                fromPortIdx: `grouped-output-${materialId}`,
                toPortIdx: 0,
                _isVirtualSinkConnection: true
              };

              if (!outputConnections.has(pm.id)) outputConnections.set(pm.id, []);
              outputConnections.get(pm.id).push(virtualConn);

              if (!inputConnections.has(VIRTUAL_SINK_ID)) inputConnections.set(VIRTUAL_SINK_ID, []);
              inputConnections.get(VIRTUAL_SINK_ID).push(virtualConn);
            });
          } else {
            const virtualConn = {
              id: `virtual_sink_conn_${pm.id}`,
              fromMachineId: pm.id,
              toMachineId: VIRTUAL_SINK_ID,
              fromPortIdx: 0,
              toPortIdx: 0,
              _isVirtualSinkConnection: true
            };

            if (!outputConnections.has(pm.id)) {
              outputConnections.set(pm.id, []);
            }
            outputConnections.get(pm.id).push(virtualConn);

            if (!inputConnections.has(VIRTUAL_SINK_ID)) {
              inputConnections.set(VIRTUAL_SINK_ID, []);
            }
            inputConnections.get(VIRTUAL_SINK_ID).push(virtualConn);
          }
        }
      }

      // Special case (TOP-LEVEL blueprints only):
      // Child machines inside blueprints that are mapped to a blueprint output port which has
      // NO external outgoing connection should behave like any other unconnected output on the main canvas:
      // attach a virtual sink to stimulate demand (sinking the output).
      //
      // IMPORTANT: This intentionally does NOT apply to nested blueprints inside another blueprint,
      // because internal blueprint outputs should only respond to external demand at the top-level.
      if (pm._isChildMachine && pm._parentBlueprintId) {
        const parentBlueprint = AF.state.build.placedMachines.find(p => p.id === pm._parentBlueprintId);
        if (parentBlueprint && parentBlueprint.portMappings && parentBlueprint.portMappings.outputs) {
          parentBlueprint.portMappings.outputs.forEach((mapping, blueprintPortIdx) => {
            if (!mapping) return;
            if (mapping.internalMachineId !== pm.id) return;

            const hasExternalConnection = AF.state.build.connections.some(conn =>
              conn.fromMachineId === pm._parentBlueprintId &&
              String(conn.fromPortIdx) === String(blueprintPortIdx)
            );
            if (hasExternalConnection) return;

            // Avoid duplicates (same internal port already has a virtual sink)
            const existingOutgoing = outputConnections.get(pm.id) || [];
            const alreadyHasVirtualSink = existingOutgoing.some(c => {
              const fromPort = c._resolvedFromPortIdx !== undefined ? c._resolvedFromPortIdx : c.fromPortIdx;
              if (String(fromPort) !== String(mapping.internalPortIdx)) return false;
              const toId = c._resolvedToMachineId || c.toMachineId;
              return toId === VIRTUAL_SINK_ID || c._isVirtualSinkConnection;
            });
            if (alreadyHasVirtualSink) return;

            const virtualConn = {
              id: `virtual_sink_conn_${pm.id}_port${mapping.internalPortIdx}`,
              fromMachineId: pm.id,
              toMachineId: VIRTUAL_SINK_ID,
              fromPortIdx: mapping.internalPortIdx,
              toPortIdx: 0,
              _isVirtualSinkConnection: true,
              _isBlueprintExport: true,
            };

            if (!outputConnections.has(pm.id)) outputConnections.set(pm.id, []);
            outputConnections.get(pm.id).push(virtualConn);

            if (!inputConnections.has(VIRTUAL_SINK_ID)) inputConnections.set(VIRTUAL_SINK_ID, []);
            inputConnections.get(VIRTUAL_SINK_ID).push(virtualConn);
          });
        }
      }
    });
    
    // Add virtual source connections for machines with missing inputs.
    // These represent IMPORTS to the production line.
    allMachines.forEach(pm => {
      // Purchasing portals are infinite sources (coins), never import.
      if (pm.type === "purchasing_portal") return;

      // Nursery: fertilizer can be provided via connection OR imported via dropdown selection.
      // If neither connected nor selected, nursery should have no required inputs (it will read as 0 output),
      // and UI shows "No Fertiliser" warning (handled elsewhere).
      if (pm.type === "nursery") {
        const hasConnectionToFertilizer = allConnections.some(conn => {
          const toId = conn._resolvedToMachineId || conn.toMachineId;
          const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
          return toId === pm.id && String(toPort) === "0";
        });
        if (!hasConnectionToFertilizer && pm.fertilizerId) {
          const virtualConn = {
            id: `virtual_source_conn_${pm.id}_fertilizer`,
            fromMachineId: VIRTUAL_SOURCE_ID,
            toMachineId: pm.id,
            fromPortIdx: 0,
            toPortIdx: 0,
            materialId: pm.fertilizerId,
            _isVirtualSourceConnection: true
          };

          if (!inputConnections.has(pm.id)) inputConnections.set(pm.id, []);
          inputConnections.get(pm.id).push(virtualConn);

          if (!outputConnections.has(VIRTUAL_SOURCE_ID)) outputConnections.set(VIRTUAL_SOURCE_ID, []);
          outputConnections.get(VIRTUAL_SOURCE_ID).push(virtualConn);
        }
        return;
      }

      // Regular machines: import any unconnected recipe inputs
      if (pm.type === "machine" && pm.recipeId) {
        const recipe = AF.core.getRecipeById(pm.recipeId);
        if (recipe && recipe.inputs && recipe.inputs.length > 0) {
          recipe.inputs.forEach((inp, portIdx) => {
            const hasConnectionToThisPort = allConnections.some(conn => {
              const toId = conn._resolvedToMachineId || conn.toMachineId;
              const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
              return toId === pm.id && String(toPort) === String(portIdx);
            });

            if (!hasConnectionToThisPort) {
              const virtualConn = {
                id: `virtual_source_conn_${pm.id}_port${portIdx}`,
                fromMachineId: VIRTUAL_SOURCE_ID,
                toMachineId: pm.id,
                fromPortIdx: 0,
                toPortIdx: portIdx,
                materialId: inp.materialId,
                _isVirtualSourceConnection: true
              };

              if (!inputConnections.has(pm.id)) inputConnections.set(pm.id, []);
              inputConnections.get(pm.id).push(virtualConn);

              if (!outputConnections.has(VIRTUAL_SOURCE_ID)) outputConnections.set(VIRTUAL_SOURCE_ID, []);
              outputConnections.get(VIRTUAL_SOURCE_ID).push(virtualConn);
            }
          });
        }
        return;
      }

      // Heating devices: if fuel port unconnected, treat fuel as imported (infinite).
      if (pm.type === "machine" && pm.machineId) {
        const machine = AF.core.getMachineById(pm.machineId);
        if (machine && machine.kind === "heating_device") {
          const hasFuelConnection = allConnections.some(conn => {
            const toId = conn._resolvedToMachineId || conn.toMachineId;
            const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
            return toId === pm.id && String(toPort) === "fuel";
          });

          if (!hasFuelConnection) {
            const virtualConn = {
              id: `virtual_source_conn_${pm.id}_fuel`,
              fromMachineId: VIRTUAL_SOURCE_ID,
              toMachineId: pm.id,
              fromPortIdx: 0,
              toPortIdx: "fuel",
              _isVirtualSourceConnection: true
            };

            if (!inputConnections.has(pm.id)) inputConnections.set(pm.id, []);
            inputConnections.get(pm.id).push(virtualConn);

            if (!outputConnections.has(VIRTUAL_SOURCE_ID)) outputConnections.set(VIRTUAL_SOURCE_ID, []);
            outputConnections.get(VIRTUAL_SOURCE_ID).push(virtualConn);
          }
        }
      }
    });
    
    // Solve efficiencies with a fixed-point iteration to handle cycles/feedback loops.
    // The prior recursive solver short-circuited cycles to 100% which produced inconsistent results.
    const MAX_ITERS = 30;
    const EPS = 1e-4;

    function computeEfficiencyForMachine(pm) {
      if (!pm || !pm.id) return 1.0;
      if (pm.id === VIRTUAL_SINK_ID || pm.id === VIRTUAL_SOURCE_ID) return 1.0;

      const machine = pm.machineId ? AF.core.getMachineById(pm.machineId) : null;
      if (machine && machine.kind === "storage") return 1.0;

      // Calculate max theoretical output for each material
      const maxOutputRates = new Map();
      const countMultiplier = AF.state.calc?.countMultiplierByMachineId?.get?.(pm.id) ?? 1;

      if (pm.type === "machine" && pm.recipeId) {
        const recipe = AF.core.getRecipeById(pm.recipeId);
        if (recipe) {
          const effectiveTime = getEffectiveProcessingTime(recipe.processingTimeSec);
          const count = (pm.count || 1) * countMultiplier;
          recipe.outputs.forEach(out => {
            if (out && out.materialId) {
              const rate = (out.items / effectiveTime) * 60 * count;
              maxOutputRates.set(out.materialId, (maxOutputRates.get(out.materialId) || 0) + rate);
            }
          });
        }
      } else if (pm.type === "nursery") {
        const rate = getPortOutputRate(pm, 0);
        if (pm.plantId) maxOutputRates.set(pm.plantId, rate);
      } else if (pm.type === "purchasing_portal") {
        const conveyorSpeed = getConveyorSpeed() * countMultiplier;
        if (pm.materialId) maxOutputRates.set(pm.materialId, conveyorSpeed);
      } else if (machine && machine.kind === "heating_device") {
        const count = (pm.count || 1) * countMultiplier;
        (pm.toppers || []).forEach(topper => {
          const topperRecipe = topper.recipeId ? AF.core.getRecipeById(topper.recipeId) : null;
          if (!topperRecipe) return;
          const effectiveTime = getEffectiveProcessingTime(topperRecipe.processingTimeSec);
          (topperRecipe.outputs || []).forEach(out => {
            if (out && out.materialId) {
              const rate = (out.items / effectiveTime) * 60 * count;
              maxOutputRates.set(out.materialId, (maxOutputRates.get(out.materialId) || 0) + rate);
            }
          });
        });
      }

      // Check if machine has all required inputs connected (including virtual imports)
      let hasAllRequiredInputs = true;
      if (pm.type === "machine" && pm.recipeId) {
        const recipe = AF.core.getRecipeById(pm.recipeId);
        if (recipe && recipe.inputs && recipe.inputs.length > 0) {
          const incomingConns = inputConnections.get(pm.id) || [];
          const connectedPortIndices = new Set(
            incomingConns.map(conn => String(conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx))
          );
          for (let i = 0; i < recipe.inputs.length; i++) {
            if (!connectedPortIndices.has(String(i))) { hasAllRequiredInputs = false; break; }
          }
        }
      } else if (pm.type === "nursery") {
        // Nursery needs fertilizer input. If none connected and none selected, it cannot run.
        const incomingConns = inputConnections.get(pm.id) || [];
        if (incomingConns.length === 0 && !pm.fertilizerId) hasAllRequiredInputs = false;
      } else if (machine && machine.kind === "heating_device") {
        const incomingConns = inputConnections.get(pm.id) || [];
        const hasFuel = incomingConns.some(conn => {
          const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
          return String(toPort) === "fuel";
        });
        if (!hasFuel) hasAllRequiredInputs = false;
      }

      if (!hasAllRequiredInputs) return 0;
      if (maxOutputRates.size === 0) return 1.0; // no outputs to constrain

      // Calculate actual demand from downstream using current target efficiencies (already stored on machines)
      const actualDemand = new Map();
      const outgoingConns = outputConnections.get(pm.id) || [];
      const portGroups = new Map();
      outgoingConns.forEach(conn => {
        const portKey = String(conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx);
        if (!portGroups.has(portKey)) portGroups.set(portKey, []);
        portGroups.get(portKey).push(conn);
      });

      portGroups.forEach((_connections, portIdx) => {
        const maxOutput = getPortOutputRate(pm, portIdx);
        const materialId = AF.core.getMaterialIdFromPort(pm, portIdx, "output");
        if (!materialId) return;
        const distribution = distributeOutputRate(pm, portIdx, maxOutput, outputConnections);
        let totalDistributed = 0;
        distribution.forEach(rate => { totalDistributed += rate; });
        actualDemand.set(materialId, (actualDemand.get(materialId) || 0) + totalDistributed);
      });

      let efficiency = 1.0;
      maxOutputRates.forEach((maxRate, materialId) => {
        const demand = actualDemand.get(materialId) || 0;
        if (maxRate > 0) efficiency = Math.min(efficiency, demand / maxRate);
      });
      return Math.max(0, Math.min(1, efficiency));
    }

    let converged = false;
    let iterationsUsed = 0;
    let finalMaxDelta = Infinity;

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      let maxDelta = 0;
      const next = new Map();
      allMachines.forEach(pm => {
        const prev = Number(pm.efficiency);
        const prevEff = Number.isFinite(prev) ? prev : 1.0;
        const nextEff = computeEfficiencyForMachine(pm);
        next.set(pm.id, nextEff);
        maxDelta = Math.max(maxDelta, Math.abs(prevEff - nextEff));
      });
      next.forEach((e, id) => {
        const m = AF.core.findMachineInTree(id);
        if (m) m.efficiency = e;
      });
      iterationsUsed = iter + 1;
      finalMaxDelta = maxDelta;
      if (maxDelta < EPS) { converged = true; break; }
    }

    AF.state.calc = AF.state.calc || {};
    AF.state.calc.solver = {
      converged,
      iterationsUsed,
      finalMaxDelta,
      eps: EPS,
      maxIters: MAX_ITERS,
    };
    
    // Update connection actual rates based on calculated efficiencies
    // Group connections by source machine and port (using RESOLVED IDs for child machines)
    const sourcePortMap = new Map(); // `${resolvedMachineId}-${resolvedPortIdx}` -> [connections]
    
    allConnections.forEach(conn => {
      // Use resolved IDs to group by actual source machine (child machine if from blueprint)
      const resolvedFromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const resolvedFromPortIdx = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
      const key = `${resolvedFromId}-${resolvedFromPortIdx}`;
      if (!sourcePortMap.has(key)) {
        sourcePortMap.set(key, []);
      }
      sourcePortMap.get(key).push(conn);
    });
    
    // Calculate distribution for each source port
    sourcePortMap.forEach((connections, key) => {
      const firstConn = connections[0];
      
      // Use resolved IDs (which already point to actual child machines)
      const sourceMachineId = firstConn._resolvedFromMachineId || firstConn.fromMachineId;
      const fromPortIdx = firstConn._resolvedFromPortIdx !== undefined ? firstConn._resolvedFromPortIdx : firstConn.fromPortIdx;
      const sourceMachine = AF.core.findMachineInTree(sourceMachineId);
      
      if (!sourceMachine) return;
      
      const sourceEfficiency = sourceMachine.efficiency || 1.0;
      const maxRate = getPortOutputRate(sourceMachine, fromPortIdx);
      const totalAvailable = maxRate * sourceEfficiency;
      
      // Use distribution algorithm (pass outputConnections to include virtual sink)
      const distribution = distributeOutputRate(sourceMachine, fromPortIdx, totalAvailable, outputConnections);
      
      // Apply distributed rates to connections
      connections.forEach(conn => {
        conn.actualRate = distribution.get(conn.id) || 0;
        conn.lastCalculated = Date.now();
      });
    });

    // Stability warning detection (used by Production Summary).
    // If the solver fails to converge, or converges to the trivial 0-throughput solution in a closed loop
    // with no sink, warn the user to add storage/export.
    (function computeStabilityWarning() {
      const solver = AF.state.calc?.solver || null;
      let warning = null;

      if (solver && solver.converged === false) {
        warning =
          "⚠ Solver could not converge to a steady state for this build. Add an Export or Storage to break cycles/ambiguity.";
      } else {
        // Detect a closed-loop with no sinks that collapsed to 0 throughput.
        const totalFlow = allConnections.reduce((sum, c) => sum + Math.abs(c.actualRate ?? 0), 0);
        const FLOW_EPS = 1e-3;

        // Any real main-canvas export sink?
        const mainExportIds = new Set(
          AF.state.build.placedMachines.filter(pm => pm.type === "export").map(pm => pm.id)
        );
        const hasExportSink = allConnections.some(c => {
          const toId = c._resolvedToMachineId || c.toMachineId;
          return mainExportIds.has(toId);
        });

        // Any storage on the canvas breaks the "no buffer" condition.
        const hasStorage = AF.core.getAllMachinesInTree().some(pm => {
          if (!pm || !pm.machineId) return false;
          const m = AF.core.getMachineById(pm.machineId);
          return !!m && m.kind === "storage";
        });

        // Any unconnected producer output implies an implicit sink exists (virtual sink).
        const machinesWithOutputs = new Set();
        allConnections.forEach(c => {
          const fromId = c._resolvedFromMachineId || c.fromMachineId;
          machinesWithOutputs.add(fromId);
        });
        const hasUnconnectedProducer = AF.core.getAllMachinesInTree().some(pm => {
          if (!pm || machinesWithOutputs.has(pm.id)) return false;
          if (pm.type === "purchasing_portal") return true;
          if (pm.type === "nursery") return !!pm.plantId;
          if (pm.type === "machine" && pm.recipeId) return true;
          if (pm.type === "machine" && pm.toppers && pm.toppers.some(t => !!t.recipeId)) return true;
          return false;
        });

        // Cycle detection in the machine connection graph (ignoring exports/storages).
        const nodes = new Set();
        AF.core.getAllMachinesInTree().forEach(pm => {
          if (!pm || !pm.id) return;
          if (pm.type === "export") return;
          if (pm.type === "purchasing_portal") return; // sources don't define stability of loop
          const m = pm.machineId ? AF.core.getMachineById(pm.machineId) : null;
          if (m && m.kind === "storage") return;
          nodes.add(pm.id);
        });
        const adj = new Map(); // id -> Array<id>
        nodes.forEach(id => adj.set(id, []));
        allConnections.forEach(c => {
          const fromId = c._resolvedFromMachineId || c.fromMachineId;
          const toId = c._resolvedToMachineId || c.toMachineId;
          if (!nodes.has(fromId)) return;
          if (!nodes.has(toId)) return;
          adj.get(fromId).push(toId);
        });
        const color = new Map(); // 0 unvisited, 1 visiting, 2 done
        nodes.forEach(id => color.set(id, 0));
        let hasCycle = false;
        function dfs(id) {
          if (hasCycle) return;
          color.set(id, 1);
          const ns = adj.get(id) || [];
          for (const nxt of ns) {
            const c = color.get(nxt) || 0;
            if (c === 1) { hasCycle = true; return; }
            if (c === 0) dfs(nxt);
            if (hasCycle) return;
          }
          color.set(id, 2);
        }
        nodes.forEach(id => { if ((color.get(id) || 0) === 0) dfs(id); });

        const hasAnyProduction = AF.core.getAllMachinesInTree().some(pm => {
          if (!pm) return false;
          if (pm.type === "nursery") return !!pm.plantId;
          if (pm.type === "machine" && pm.recipeId) return true;
          if (pm.type === "machine" && pm.toppers && pm.toppers.some(t => !!t.recipeId)) return true;
          return false;
        });

        if (
          hasAnyProduction &&
          totalFlow < FLOW_EPS &&
          hasCycle &&
          !hasExportSink &&
          !hasUnconnectedProducer &&
          !hasStorage
        ) {
          warning =
            "⚠ This build forms a self-contained feedback loop with no sink/buffer. The solver collapses to 0 throughput (indeterminate). Add an Export or Storage on a loop output.";
        }
      }

      AF.state.calc.stabilityWarning = warning;
    })();

    // Update blueprint instances with an EXTERNAL-IO utilization efficiency (for UI display only).
    // This is NOT based on internal child machine efficiencies; it's a "do we have spare capacity"
    // indicator based on:
    // - external output demand vs blueprint max output capacity (belt limits via actualRate),
    // - and external input supply vs required input capacity.
    AF.state.build.placedMachines.forEach(pm => {
      if (!(pm.type === "blueprint_instance" || pm.type === "blueprint")) return;
      if (!pm.childMachines || !pm.portMappings) return;

      const outputMappings = pm.portMappings.outputs || [];
      const inputMappings = pm.portMappings.inputs || [];

      const exportChildIds = new Set(
        (pm.childMachines || []).filter(m => m.type === "export").map(m => m.id)
      );

      const getExternalOutputRate = (portIdx) => {
        // External connections from the blueprint instance port (top-level only)
        let rate = 0;
        AF.state.build.connections.forEach(c => {
          if (c.fromMachineId !== pm.id) return;
          if (String(c.fromPortIdx) !== String(portIdx)) return;
          rate += (c.actualRate ?? 0);
        });
        return rate;
      };

      const outputPortHasInfiniteSink = (mapping) => {
        if (!mapping) return false;

        // If the mapped internal output already feeds an Export node (or virtual sink),
        // then output-demand is effectively infinite and the blueprint should not show "spare capacity"
        // for this port.
        const allConns = AF.core.getAllConnectionsInTree();
        return allConns.some(c => {
          const fromId = c._resolvedFromMachineId || c.fromMachineId;
          const fromPort = c._resolvedFromPortIdx !== undefined ? c._resolvedFromPortIdx : c.fromPortIdx;
          if (fromId !== mapping.internalMachineId) return false;
          if (String(fromPort) !== String(mapping.internalPortIdx)) return false;

          const toId = c._resolvedToMachineId || c.toMachineId;
          if (toId === "__virtual_sink__" || c._isVirtualSinkConnection) return true;
          if (exportChildIds.has(toId)) return true;
          const target = AF.core.findMachineInTree(toId);
          return !!target && target.type === "export";
        });
      };

      const getExternalInputRate = (portIdx) => {
        let rate = 0;
        AF.state.build.connections.forEach(c => {
          if (c.toMachineId !== pm.id) return;
          if (String(c.toPortIdx) !== String(portIdx)) return;
          rate += (c.actualRate ?? 0);
        });
        return rate;
      };

      let ioEfficiency = 1.0;

      // Outputs:
      // - If the port is backed by an infinite sink (Export node or virtual sink), treat as fully utilized.
      // - Otherwise compare external usage vs blueprint port capacity.
      outputMappings.forEach((mapping, portIdx) => {
        if (!mapping) return;
        if (outputPortHasInfiniteSink(mapping)) return; // full utilization for UI badge

        const capacity = getPortOutputRate(pm, portIdx) || 0;
        if (capacity <= 0) return;
        const used = getExternalOutputRate(portIdx);
        ioEfficiency = Math.min(ioEfficiency, Math.max(0, Math.min(1, used / capacity)));
      });

      // Inputs: treat "no external connection" as fully supplied via imports (virtual source),
      // but if externally connected, show underutilization when supply is below required capacity.
      inputMappings.forEach((mapping, portIdx) => {
        if (!mapping) return;
        const required = getPortInputDemand(pm, portIdx) || 0;
        if (required <= 0) return;
        const supplied = getExternalInputRate(portIdx);
        if (supplied <= 0.0001) return; // imported (assumed unlimited) => no underclock
        ioEfficiency = Math.min(ioEfficiency, Math.max(0, Math.min(1, supplied / required)));
      });

      pm.efficiency = ioEfficiency;
    });
  }

  function getNetProduction(selectedMachineIds = null) {
    // Calculate imports and exports separately - they should NOT cancel each other out!
    // A production line can both export and import the same material type
    // Uses physical instance model - all machines (including blueprint children) are in tree
    const productionRates = calculateProductionFlow(selectedMachineIds);
    const exports = new Map(); // materialId -> export rate (materials leaving the system)
    const imports = new Map(); // materialId -> import rate (materials entering the system)
    
    // Get all machines in tree (including blueprint children as physical instances)
    const allMachines = selectedMachineIds 
      ? AF.state.build.placedMachines.filter(pm => selectedMachineIds.includes(pm.id))
      : AF.core.getAllMachinesInTree();
    
    // Get all REAL connections (not virtual)
    const allConnections = AF.core.getAllConnectionsInTree();
    
    // Only top-level Export nodes (main canvas) count as exports.
    // Export nodes inside blueprints are metadata-only and must not contribute to exports.
    const exportNodeIds = new Set(
      allMachines
        .filter(pm => pm.type === "export" && !pm._isChildMachine)
        .map(pm => pm.id)
    );

    // 1) Explicit exports: any real connection that goes into an Export node counts as export.
    // Use actual distributed rates to correctly capture "surplus" in self-fed/cyclic graphs.
    allConnections.forEach(conn => {
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      if (!exportNodeIds.has(toId)) return;

      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const fromPortIdx = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
      const source = AF.core.findMachineInTree(fromId);
      if (!source) return;

      const materialId = AF.core.getMaterialIdFromPort(source, fromPortIdx, "output");
      if (!materialId) return;

      const rate = conn.actualRate ?? 0;
      if (rate <= 0) return;

      exports.set(materialId, (exports.get(materialId) || 0) + rate);
    });

    // 2) Implicit exports/imports: unconnected producers/consumers
    allMachines.forEach(pm => {
      const rates = productionRates.get(pm.id);
      if (!rates) return;
      
      // Skip machines with 0 efficiency (not producing/consuming anything)
      const efficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
      if (efficiency === 0) return;
      
      // Check if this machine has real input connections
      const hasRealInputs = allConnections.some(conn => {
        const toId = conn._resolvedToMachineId || conn.toMachineId;
        return toId === pm.id;
      });
      
      // Check if this machine has any real output connections.
      // NOTE: Connections to a MAIN-CANVAS Export node DO count as real outputs here,
      // because explicit exports are counted in step (1). Excluding them would cause
      // double-counting (explicit + implicit).
      const hasRealOutputs = allConnections.some(conn => {
        const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
        const toId = conn._resolvedToMachineId || conn.toMachineId;
        // Ignore blueprint-internal Export nodes (metadata-only)
        const target = AF.core.findMachineInTree(toId);
        if (target && target.type === "export" && target._isChildMachine) return false;
        return fromId === pm.id;
      });
      
      // Purchasing portals are infinite sources (coins assumed infinite).
      // Nurseries are NOT infinite sources (they require fertilizer, which must be supplied/imported).
      const isInfiniteSource = pm.type === "purchasing_portal";
      
      // Track IMPORTS: machines needing inputs but have no real input connections
      rates.inputs.forEach(inp => {
        if (!inp.materialId || inp.rate === 0) return;
        
        if (!hasRealInputs && !isInfiniteSource) {
          // Machine needs inputs but has none connected = must be imported
          const current = imports.get(inp.materialId) || 0;
          imports.set(inp.materialId, current + inp.rate);
        }
        // Machines with real inputs get materials internally (no import needed)
        // Infinite sources don't import (coins/fuel assumed infinite)
      });
      
      // Track EXPORTS: machines producing outputs but have no real output connections
      rates.outputs.forEach(out => {
        if (!out.materialId || out.rate === 0) return;
        
        if (!hasRealOutputs && !isInfiniteSource) {
          // Machine produces but has no outputs connected = must be exported
          const current = exports.get(out.materialId) || 0;
          exports.set(out.materialId, current + out.rate);
        }
        // Machines with real outputs send materials internally (no export)
        // Infinite sources only produce what's consumed (no export)
      });
    });
    
    // Return a structure with both exports and imports
    // They should NOT be netted against each other!
    return { exports, imports };
  }
  
  /**
   * Calculate coin costs from purchasing portals
   * @returns {object} { totalCopper: number, breakdown: Map<materialId, {rate, costPerMinute, material}> }
   */
  function calculatePurchasingCosts() {
    const breakdown = new Map(); // materialId -> { rate, costPerMinute, material }
    let totalCopper = 0;
    
    // Get all machines in tree (including blueprint children as physical instances)
    const allMachines = AF.core.getAllMachinesInTree();
    
    allMachines.forEach(pm => {
      if (pm.type !== "purchasing_portal") return;
      if (!pm.materialId) return;
      
      const material = AF.core.getMaterialById(pm.materialId);
      if (!material || !material.buyPrice) return;
      
      // Get actual output rate (affected by efficiency/backpressure)
      const efficiency = pm.efficiency !== undefined ? pm.efficiency : 1.0;
      // Use port output capacity (includes blueprint quantity multipliers)
      const maxRate = getPortOutputRate(pm, 0);
      const actualRate = maxRate * efficiency;
      
      // Calculate cost per minute in copper
      const costPerMinute = actualRate * material.buyPrice;
      
      // Add to breakdown
      if (breakdown.has(pm.materialId)) {
        const existing = breakdown.get(pm.materialId);
        existing.rate += actualRate;
        existing.costPerMinute += costPerMinute;
      } else {
        breakdown.set(pm.materialId, {
          rate: actualRate,
          costPerMinute: costPerMinute,
          material: material
        });
      }
      
      totalCopper += costPerMinute;
    });
    
    return { totalCopper, breakdown };
  }

  
  /**
   * Get detailed information about why a cost can't be calculated
   */
  function getCostCalculationDetails(materialId, depth = 0) {
    const material = AF.core.getMaterialById(materialId);
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
    const recipes = AF.state.db.recipes.filter(r => 
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
        
        const inputMat = AF.core.getMaterialById(input.materialId);
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
    
    const material = AF.core.getMaterialById(materialId);
    if (!material) return Infinity;
    
    let minCost = Infinity;
    
    // Option 1: Buy price
    if (material.buyPrice != null && material.buyPrice >= 0) {
      minCost = material.buyPrice;
    }
    
    // Option 2: Production cost from recipes
    const producingRecipes = AF.state.db.recipes.filter(r => 
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


  
  // ---------- Skill Calculation Helpers ----------

  /**
   * Get effective conveyor speed with skill bonus
   * Base: 60/min, +15/min per skill point
   */
  function getConveyorSpeed() {
    return AF.consts.CONVEYOR_SPEED + (AF.state.skills.conveyorSpeed * 15);
  }

  /**
   * Get effective throwing speed with skill bonus
   * Base: 60/min, +15/min per skill point
   */
  function getThrowingSpeed() {
    return AF.consts.CONVEYOR_SPEED + (AF.state.skills.throwingSpeed * 15);
  }

  /**
   * Get effective processing time with machine efficiency skill
   * Each point reduces time by 25% (multiplicative)
   * @param {number} baseTimeInSec - Base processing time in seconds
   * @returns {number} Adjusted processing time
   */
  function getFactoryEfficiency(baseTimeInSec) {
    // Reduce time by 25% per point: time * (1 - 0.25 * skill)
    const reduction = AF.state.skills.machineEfficiency * 0.25;
    return baseTimeInSec * (1 - Math.min(reduction, 1)); // Cap at 95% reduction
  }

  /**
   * Get fuel consumption rate with skill adjustment
   * Each Machine Efficiency point increases consumption by 25%
   * @param {number} baseConsumptionP - Base consumption rate in Pyra/P per second
   * @returns {number} Adjusted consumption rate in Pyra/P per second
   */
  function getFuelConsumptionRate(baseConsumptionP) {
    return baseConsumptionP * (1 + (0.25 * AF.state.skills.machineEfficiency));
  }

  /**
   * Get fuel Heat Value with skill adjustment
   * Each point increases fuel value by 10%
   * @param {number} totalBaseP - Base Heat Value in Pyra/P
   * @returns {number} Adjusted Heat Value in Pyra/P
   */
  function getFuelHeatValue(totalBaseP) {
    return totalBaseP * (1 + (0.10 * AF.state.skills.fuelEfficiency));
  }

  /**
   * Get fertilizer value with skill adjustment
   * Each point increases value by 10%
   * @param {number} totalBaseV - Base fertilizer value
   * @returns {number} Adjusted fertilizer value
   */
  function getFertilizerValue(totalBaseV) {
    return totalBaseV * (1 + (0.10 * AF.state.skills.fertilizerEfficiency));
  }

  /**
   * Get profit with skill adjustment
   * Each point increases profit by 3%
   * @param {number} basePriceC - Base price in coins
   * @returns {number} Adjusted price
   */
  function getProfit(basePriceC) {
    return basePriceC * (1 + (0.03 * AF.state.skills.shopProfit));
  }

  /**
   * Get alchemy efficiency (extractor output bonus)
   * Each point adds 3% output
   * @param {number} baseOutput - Base output amount
   * @returns {number} Adjusted output
   */
  function getAlchemyEfficiency(baseOutput) {
    return baseOutput * (1 + (0.03 * AF.state.skills.alchemyEfficiency));
  }

  // Legacy aliases for backward compatibility
  function getEffectiveConveyorSpeed() {
    return getConveyorSpeed();
  }

  function getEffectiveProcessingTime(baseTime) {
    return getFactoryEfficiency(baseTime);
  }
  
  /**
   * Get output rate for a specific port on a machine
   * @param {object} placedMachine - The placed machine
   * @param {number} portIdx - Output port index
   * @returns {number} Rate (items/min)
   */
  function getPortOutputRate(placedMachine, portIdx) {
    const countMultiplier = AF.state.calc?.countMultiplierByMachineId?.get?.(placedMachine.id) ?? 1;
    const effectiveCount = (placedMachine.count || 1) * countMultiplier;

    // Blueprint types
    if (placedMachine.type === "blueprint" || placedMachine.type === "blueprint_instance") {
      const portIdxNum = parseInt(portIdx);

      // Try new physical model first (calculate from child machines)
      if (placedMachine.portMappings && placedMachine.childMachines) {
        const mapping = placedMachine.portMappings.outputs?.[portIdxNum];
        if (mapping) {
          const childMachine = placedMachine.childMachines.find(m => m.id === mapping.internalMachineId);
          if (childMachine) {
            // Get rate from actual child machine
            const childRate = getPortOutputRate(childMachine, mapping.internalPortIdx);
            // Child machines already include blueprint quantity multipliers via `countMultiplierByMachineId`.
            return childRate;
          }
        }
        return 0;
      }

      // Fall back to old model (blueprintData with manual efficiency scaling)
      const bpData = placedMachine.blueprintData || {};
      const output = bpData.outputs?.[portIdxNum];
      const count = placedMachine.count || 1;
      const efficiency = placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0;
      return (output?.rate || 0) * count * efficiency;
    }

    const machine = AF.core.getMachineById(placedMachine.machineId);
    if (!machine) {
      // Special types without machineId
      if (placedMachine.type === "purchasing_portal") {
        return getConveyorSpeed() * effectiveCount;
      }
      // (Fuel Source node removed)
      if (placedMachine.type === "storage") {
        // Storage: Each output port is independently capped at conveyor speed
        // This represents a single belt/port, not multiple belts
        return getConveyorSpeed();
      }
      if (placedMachine.type === "nursery") {
        // Calculate nursery output rate
        const plant = placedMachine.plantId ? AF.core.getMaterialById(placedMachine.plantId) : null;
        if (!plant || !plant.plantRequiredNutrient) return 0;

        // Get fertilizer from connected input OR selected fertilizer
        let fertilizer = null;
        const incomingConnections = AF.core.getAllConnectionsInTree().filter(conn => {
          const toId = conn._resolvedToMachineId || conn.toMachineId;
          return toId === placedMachine.id;
        });

        if (incomingConnections.length > 0) {
          const sourceConn = incomingConnections[0];
          const fromId = sourceConn._resolvedFromMachineId || sourceConn.fromMachineId;
          const fromPort = sourceConn._resolvedFromPortIdx !== undefined ? sourceConn._resolvedFromPortIdx : sourceConn.fromPortIdx;
          const sourceMachine = AF.core.findMachineInTree(fromId);
          if (sourceMachine) {
            const fertId =  AF.core.getMaterialIdFromPort(sourceMachine, fromPort, "output");
            if (fertId) {
              fertilizer = AF.core.getMaterialById(fertId);
            }
          }
        }

        // If no connection, use selected fertilizer
        if (!fertilizer && placedMachine.fertilizerId) {
          fertilizer = AF.core.getMaterialById(placedMachine.fertilizerId);
        }

        if (!fertilizer || !fertilizer.isFertilizer || !fertilizer.fertilizerMaxFertility) return 0;

        const Nv = plant.plantRequiredNutrient;
        const Ff = fertilizer.fertilizerMaxFertility; // Max Fertility is NOT affected by skill

        // Plant Growth Time = Nv / Ff
        const growthTime = Nv / Ff;

        // Output Rate = 60 / growthTime (per nursery)
        const outputPerNursery = 60 / growthTime;

        // Multiply by nursery count
        return outputPerNursery * effectiveCount;
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
          const topperRecipe = AF.core.getRecipeById(topper.recipeId);
          if (!topperRecipe) return;

          const effectiveTime = getFactoryEfficiency(topperRecipe.processingTimeSec);
          topperRecipe.outputs.forEach(out => {
            if (out.materialId === materialId) {
              totalRate += (out.items / effectiveTime) * 60;
            }
          });
        });

        // Multiply by furnace count
        return totalRate * effectiveCount;
      }

      // Handle individual topper ports (legacy, for backward compatibility)
      if (portIdx.startsWith('topper-')) {
        const match = portIdx.match(/^topper-(\d+)-(\d+)$/);
        if (match) {
          const topperIdx = parseInt(match[1]);
          const topperPortIdx = parseInt(match[2]);
          const topper = placedMachine.toppers?.[topperIdx];

          if (topper && topper.recipeId) {
            const topperRecipe = AF.core.getRecipeById(topper.recipeId);
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
      const recipe = AF.core.getRecipeById(placedMachine.recipeId);
      if (!recipe || !recipe.outputs[portIdx]) return 0;

      const effectiveTime = getFactoryEfficiency(recipe.processingTimeSec);
      return (recipe.outputs[portIdx].items / effectiveTime) * 60 * effectiveCount;
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
    const countMultiplier = AF.state.calc?.countMultiplierByMachineId?.get?.(placedMachine.id) ?? 1;
    const effectiveCount = (placedMachine.count || 1) * countMultiplier;

    // Blueprint types
    if (placedMachine.type === "blueprint" || placedMachine.type === "blueprint_instance") {
      const portIdxNum = parseInt(portIdx);

      // Try new physical model first (calculate from child machines)
      if (placedMachine.portMappings && placedMachine.childMachines) {
        const mapping = placedMachine.portMappings.inputs?.[portIdxNum];
        if (mapping) {
          const childMachine = placedMachine.childMachines.find(m => m.id === mapping.internalMachineId);
          if (childMachine) {
            // Get demand from actual child machine (already includes its efficiency)
            const childDemand = getPortInputDemand(childMachine, mapping.internalPortIdx);
            // Child machines already include blueprint quantity multipliers via `countMultiplierByMachineId`.
            return childDemand;
          }
        }
        return 0;
      }

      // Fall back to old model (blueprintData with manual efficiency scaling)
      const bpData = placedMachine.blueprintData || {};
      const input = bpData.inputs?.[portIdxNum];
      const count = placedMachine.count || 1;
      const efficiency = placedMachine.efficiency !== undefined ? placedMachine.efficiency : 1.0;
      return (input?.rate || 0) * count * efficiency;
    }

    const machine = AF.core.getMachineById(placedMachine.machineId);
    if (!machine) {
      // Handle special types without machineId
      if (placedMachine.type === "nursery") {
        // Calculate nursery fertilizer input demand
        const plant = placedMachine.plantId ? AF.core.getMaterialById(placedMachine.plantId) : null;
        if (!plant || !plant.plantRequiredNutrient) return 0;

        // Get fertilizer from connected input OR selected fertilizer
        let fertilizer = null;
        const incomingConnections = AF.core.getAllConnectionsInTree().filter(conn => {
          const toId = conn._resolvedToMachineId || conn.toMachineId;
          return toId === placedMachine.id;
        });

        if (incomingConnections.length > 0) {
          const sourceConn = incomingConnections[0];
          const fromId = sourceConn._resolvedFromMachineId || sourceConn.fromMachineId;
          const fromPort = sourceConn._resolvedFromPortIdx !== undefined ? sourceConn._resolvedFromPortIdx : sourceConn.fromPortIdx;
          const sourceMachine = AF.core.findMachineInTree(fromId);
          if (sourceMachine) {
            const fertId = AF.core.getMaterialIdFromPort(sourceMachine, fromPort, "output");
            if (fertId) {
              fertilizer = AF.core.getMaterialById(fertId);
            }
          }
        }

        // If no connection, use selected fertilizer
        if (!fertilizer && placedMachine.fertilizerId) {
          fertilizer = AF.core.getMaterialById(placedMachine.fertilizerId);
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
        return inputPerNursery * effectiveCount;
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
        const topperMachine = AF.core.getMachineById(topper.machineId);
        if (topperMachine) {
          totalHeatP += getFuelConsumptionRate(topperMachine.heatConsumptionP || 0);
        }
      });

      // Multiply by furnace count
      totalHeatP *= effectiveCount;

      // Prefer incoming fuel connection (actual fuel)
      // IMPORTANT: Must consider blueprint childConnections too (tree), not just top-level build connections.
      const fuelConnection = AF.core.getAllConnectionsInTree().find(conn => {
        const toId = conn._resolvedToMachineId || conn.toMachineId;
        const toPort = conn._resolvedToPortIdx !== undefined ? conn._resolvedToPortIdx : conn.toPortIdx;
        return toId === placedMachine.id && String(toPort) === "fuel";
      });

      /** @type {string|null} */
      let fuelMaterialId = null;
      if (fuelConnection) {
        const fromId = fuelConnection._resolvedFromMachineId || fuelConnection.fromMachineId;
        const fromPort = fuelConnection._resolvedFromPortIdx !== undefined ? fuelConnection._resolvedFromPortIdx : fuelConnection.fromPortIdx;
        const sourceMachine = AF.core.findMachineInTree(fromId);
        if (sourceMachine) {
          fuelMaterialId = AF.core.getMaterialIdFromPort(sourceMachine, fromPort, "output");
        }
      } else {
        // Preview fuel mode (no connection) should still count as an import requirement
        fuelMaterialId = placedMachine.previewFuelId || null;
      }

      const fuelMaterial = fuelMaterialId ? AF.core.getMaterialById(fuelMaterialId) : null;
      if (fuelMaterial && fuelMaterial.fuelValue) {
        const adjustedFuelValue = getFuelHeatValue(fuelMaterial.fuelValue);
        if (adjustedFuelValue > 0) return (60 * totalHeatP) / adjustedFuelValue;
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
        const topperRecipe = AF.core.getRecipeById(topper.recipeId);
        if (!topperRecipe) return;

        const effectiveTime = getFactoryEfficiency(topperRecipe.processingTimeSec);
        topperRecipe.inputs.forEach(inp => {
          if (inp.materialId === materialId) {
            totalDemand += (inp.items / effectiveTime) * 60;
          }
        });
      });

      // Multiply by furnace count
      return totalDemand * effectiveCount;
    }

    // Regular machines with recipes have fixed input demand
    if (placedMachine.recipeId) {
      const recipe = AF.core.getRecipeById(placedMachine.recipeId);
      if (!recipe || !recipe.inputs[portIdx]) return 0;

      const effectiveTime = getFactoryEfficiency(recipe.processingTimeSec);
      return (recipe.inputs[portIdx].items / effectiveTime) * 60 * effectiveCount;
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
    const machine = AF.core.getMachineById(placedStorage.machineId);
    if (!machine || machine.kind !== "storage") return 0;

    const allConnections = AF.core.getAllConnectionsInTree();

    // Check if this specific port is connected
    const portConnection = allConnections.find(conn => {
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
      return fromId === placedStorage.id && String(fromPort) === String(portIdx);
    });

    // If this port isn't connected, return 0
    if (!portConnection) {
      return 0;
    }

    // Get the downstream machine and its demand
    const toId = portConnection._resolvedToMachineId || portConnection.toMachineId;
    const toPort = portConnection._resolvedToPortIdx !== undefined ? portConnection._resolvedToPortIdx : portConnection.toPortIdx;
    const destMachine = AF.core.findMachineInTree(toId);
    if (!destMachine) return 0;

    const demand = getPortInputDemand(destMachine, toPort);

    // Get all incoming connections to determine available input
    const incomingConnections = allConnections.filter(conn => {
      const toId = conn._resolvedToMachineId || conn.toMachineId;
      return toId === placedStorage.id;
    });

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
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      const fromPort = conn._resolvedFromPortIdx !== undefined ? conn._resolvedFromPortIdx : conn.fromPortIdx;
      const sourceMachine = AF.core.findMachineInTree(fromId);
      if (!sourceMachine) return;

      // Get the rate from the source machine's output port
      const sourceRate = getPortOutputRate(sourceMachine, fromPort);
      totalInputRate += sourceRate;
    });

    // Get count of connected output ports
    const connectedOutputs = allConnections.filter(conn => {
      const fromId = conn._resolvedFromMachineId || conn.fromMachineId;
      return fromId === placedStorage.id;
    }).length;

    if (connectedOutputs === 0) return 0;

    // Available rate per connected port
    const availablePerPort = totalInputRate / connectedOutputs;

    // Output at the minimum of: available rate, demand, or conveyor speed
    return Math.min(availablePerPort, demand, getConveyorSpeed());
  }



  Object.assign(AF.calculator, {
    init,
    recalculateAll,
    calculateBlueprintMachineCounts,
    invalidateBlueprintCountCache,
    analyzeBlueprintMachines,
    getConveyorSpeed,
    getEffectiveConveyorSpeed,
    getFuelConsumptionRate,
    getFuelHeatValue,
    getFertilizerValue,
    getProfit,
    getAlchemyEfficiency,
    getEffectiveProcessingTime,
    getCostCalculationDetails,
    calculateRealizedCost
  });


})();

