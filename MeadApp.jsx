import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  updateDoc,
  serverTimestamp,
  setLogLevel
} from 'firebase/firestore';
import { 
  Beaker, 
  Save, 
  Plus, 
  Trash2, 
  Droplet, 
  Calendar, 
  BookOpen, 
  Activity, 
  ChevronRight, 
  ArrowLeft,
  Wine,
  Scale,
  Pencil,
  Wand2
} from 'lucide-react';

// Setting log level to error to avoid excessive console output, but you can change this to 'debug'
// if you need to troubleshoot Firestore connection issues.
setLogLevel('error');

// --- Firebase Configuration ---
const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// --- Constants & Math Helpers ---
const HONEY_PPG = 35; // Points per Pound per Gallon
const SUCROSE_PPG = 46; // Pure sugar PPG (used to calc fruit contribution)

// Conversion Factors
const LITERS_TO_GAL = 0.264172;
const KG_TO_LBS = 2.20462;

const sgToAbv = (og, fg) => ((og - fg) * 131.25).toFixed(1);
const abvToOg = (abv) => (1 + (abv / 131.25));

// Helper function for safely converting Firestore Timestamp, Date object, or ISO string to Date
const safeGetDate = (timestamp) => {
  if (timestamp && timestamp.seconds) {
    // 1. Firestore Timestamp object
    return new Date(timestamp.seconds * 1000);
  }
  if (typeof timestamp === 'string' && !isNaN(new Date(timestamp))) {
    // 2. ISO Date String (used for logs in arrays)
    return new Date(timestamp);
  }
  if (timestamp instanceof Date) {
    // 3. Already a JavaScript Date object (used for optimistic UI updates)
    return timestamp;
  }
  // 4. Fallback if timestamp is null or pending
  return new Date(); 
};

// Format Date for display and input default
const formatDate = (date) => {
    const d = safeGetDate(date);
    // Format to YYYY-MM-DD for input type="date"
    return d.toISOString().split('T')[0];
};

// Approximate Sugar content by weight (Brixish)
const FRUIT_DATA = [
  { name: 'Apple', sugar: 13 },
  { name: 'Apricot', sugar: 9 },
  { name: 'Blackberry', sugar: 8 },
  { name: 'Blueberry', sugar: 12 },
  { name: 'Cherry (Sweet)', sugar: 14 },
  { name: 'Cherry (Tart)', sugar: 10 },
  { name: 'Cranberry', sugar: 4 },
  { name: 'Currant (Black)', sugar: 10 },
  { name: 'Dates (Dried)', sugar: 65 },
  { name: 'Fig (Fresh)', sugar: 16 },
  { name: 'Fig (Dried)', sugar: 55 },
  { name: 'Grape (Red)', sugar: 16 },
  { name: 'Grape (White)', sugar: 16 },
  { name: 'Mango', sugar: 14 },
  { name: 'Orange', sugar: 9 },
  { name: 'Peach', sugar: 8 },
  { name: 'Pear', sugar: 10 },
  { name: 'Pineapple', sugar: 13 },
  { name: 'Plum', sugar: 10 },
  { name: 'Raisins', sugar: 60 },
  { name: 'Raspberry', sugar: 5 },
  { name: 'Strawberry', sugar: 6 },
  { name: 'Custom', sugar: 10 },
];

// --- Status Configuration ---
const BATCH_STATUSES = {
    brewing: { label: 'Primary Fermentation (Brewing)', color: 'bg-red-50 text-red-800 border-red-200', icon: Beaker },
    racked: { label: 'Secondary/Aging (Racked)', color: 'bg-blue-50 text-blue-800 border-blue-200', icon: Droplet },
    bottled: { label: 'Finished (Bottled)', color: 'bg-green-50 text-green-800 border-green-200', icon: Wine },
    archived: { label: 'Archived', color: 'bg-gray-50 text-gray-800 border-gray-200', icon: BookOpen },
};
const BATCH_STATUS_OPTIONS = Object.keys(BATCH_STATUSES);


// --- Components ---

// 1. Calculator View
const Calculator = ({ onSave, onStartBatch, initialData = null, isStartingBatch = false, onBackToFavorites }) => {
  const [mode, setMode] = useState('target'); // 'target' or 'ingredients'
  const [volume, setVolume] = useState(5); // Liters
  const [targetAbv, setTargetAbv] = useState(12);
  const [honeyAmount, setHoneyAmount] = useState(1.5); // kg
  const [fruits, setFruits] = useState([]); 
  const [recipeName, setRecipeName] = useState('');
  const [recipeId, setRecipeId] = useState(null); // State to hold the ID if loaded from favorites

  // Helper for unique IDs for fruit entries
  const getNewFruitId = () => Date.now() + Math.random();

  // Reset or Load initial data
  useEffect(() => {
    if (initialData) {
      setMode(initialData.mode || 'ingredients');
      setVolume(initialData.volume || 5);
      setTargetAbv(initialData.targetAbv || 12);
      setHoneyAmount(initialData.honeyAmount || 1.5);
      // Ensure fruits have a unique ID for React keys and manipulation
      setFruits(initialData.fruits?.map(f => ({ ...f, id: f.id || getNewFruitId() })) || []);
      setRecipeName(initialData.name || '');
      setRecipeId(initialData.id || null); // <--- Store the original recipe ID
    } else {
      // Initialize a fresh calculator
      setMode('target');
      setVolume(5);
      setTargetAbv(12);
      setHoneyAmount(1.5);
      setFruits([]);
      setRecipeName('');
      setRecipeId(null); // <--- Reset ID for new recipes
    }
  }, [initialData]);

  // Calculations
  const calculations = useMemo(() => {
    // Helper to safely get numeric values from state strings/numbers
    const safeNum = (val) => (val === '' ? 0 : parseFloat(val) || 0);

    // Convert inputs to US units for PPG math
    const volLiters = safeNum(volume);
    const volGal = volLiters * LITERS_TO_GAL;
    
    if (mode === 'target') {
      // Logic: Have Volume + Target ABV -> Need Honey
      const targetAbvNum = safeNum(targetAbv);
      const targetOg = abvToOg(targetAbvNum);
      const totalPointsNeeded = (targetOg - 1) * 1000 * volGal;
      
      const honeyLbsNeeded = totalPointsNeeded / HONEY_PPG;
      const honeyKgNeeded = honeyLbsNeeded / KG_TO_LBS;

      return {
        og: targetOg.toFixed(3),
        honeyNeeded: Math.max(0, honeyKgNeeded).toFixed(2), // Returns kg
        totalPoints: totalPointsNeeded
      };
    } else {
      // Logic: Have Volume + Ingredients -> Need ABV/OG
      const honeyKg = safeNum(honeyAmount);
      const honeyLbs = honeyKg * KG_TO_LBS;
      const honeyPoints = honeyLbs * HONEY_PPG;
      
      // Calculate Fruit Points based on Sugar %
      const fruitPoints = fruits.reduce((acc, f) => {
        const fruitKg = safeNum(f.amount);
        const fruitLbs = fruitKg * KG_TO_LBS;
        const sugarPct = safeNum(f.sugarPercent) / 100;
        
        // Logic: Total Fruit Weight * Sugar % = Pure Sugar Weight
        // Pure Sugar Weight * 46 (PPG of sucrose) = Points
        const ppgContribution = SUCROSE_PPG * sugarPct; 
        
        return acc + (fruitLbs * ppgContribution);
      }, 0);
      
      const totalPoints = honeyPoints + fruitPoints;
      // Points per Gallon = Total Points / Gallons
      const gravityPoints = volGal > 0 ? totalPoints / volGal : 0;
      const estimatedOg = 1 + (gravityPoints / 1000);
      const estimatedAbv = sgToAbv(estimatedOg, 1.000); // Assuming fermentation to dry
      
      return {
        og: estimatedOg.toFixed(3),
        abv: estimatedAbv
      };
    }
  }, [mode, volume, targetAbv, honeyAmount, fruits]);

  const handleAddFruit = () => {
    setFruits([...fruits, { id: getNewFruitId(), name: '', amount: 0, sugarPercent: 10 }]);
  };

  const handleRemoveFruit = (id) => {
    setFruits(fruits.filter(f => f.id !== id));
  };

  const handleFruitChange = (id, field, value) => {
    setFruits(fruits.map(f => {
      if (f.id !== id) return f;
      // Ensure numeric fields can accept empty strings for better UX
      if (field === 'amount' || field === 'sugarPercent') {
        return { ...f, [field]: value === '' ? '' : parseFloat(value) };
      }
      return { ...f, [field]: value };
    }));
  };

  // Special handler for the preset dropdown
  const handleFruitPresetSelect = (id, presetName) => {
    const preset = FRUIT_DATA.find(p => p.name === presetName);
    if (preset) {
      setFruits(fruits.map(f => {
        if (f.id !== id) return f;
        return { ...f, name: presetName === 'Custom' ? '' : presetName, sugarPercent: preset.sugar };
      }));
    }
  };

  const generateRecipeData = () => {
    const calculatedOg = calculations.og;
    const calculatedAbv = mode === 'ingredients' ? calculations.abv : targetAbv;

    // Filter out fruits with no name
    const finalFruits = fruits.filter(f => f.name.trim() !== '');

    const data = {
      name: recipeName,
      mode,
      volume: parseFloat(volume) || 0,
      targetAbv: parseFloat(targetAbv) || 0,
      honeyAmount: parseFloat(honeyAmount) || 0,
      fruits: finalFruits,
      calculatedOg: calculatedOg,
      calculatedAbv: calculatedAbv,
      // Pass the original recipe ID if it exists (for batch tracking)
      ...(recipeId && { id: recipeId }), 
    };

    return data;
  }

  const handleSave = () => {
    if (!recipeName.trim()) {
      // IMPORTANT: Custom modal UI should be used here instead of alert()
      alert("Please name your recipe before saving."); 
      return;
    }
    const recipeData = { ...generateRecipeData(), timestamp: serverTimestamp() };
    
    // Ensure we delete the ID if we are saving a *new* recipe, since generateRecipeData might include it.
    delete recipeData.id; 
    
    onSave(recipeData);
    if (!isStartingBatch) {
      setRecipeName(''); // Only clear name if saving a new recipe, not if we're prepping a batch
    }
  };
  
  const handleStartBatch = () => {
      if (!recipeName.trim()) {
        // IMPORTANT: Custom modal UI should be used here instead of alert()
        alert("Please name your batch before starting."); 
        return;
      }
      const batchData = generateRecipeData();
      onStartBatch(batchData);
  }

  // Helper function to handle input change for volume, abv, and honey
  const handleNumericChange = (setter) => (e) => {
    const value = e.target.value;
    if (value === '') {
      setter(''); // Allow empty string for better UX (so user can clear the field)
    } else {
      setter(parseFloat(value));
    }
  };

  const isSaveDisabled = !recipeName.trim() || !volume || (mode === 'target' && !targetAbv) || (mode === 'ingredients' && !honeyAmount);


  return (
    <div className="space-y-6 pb-24">
      {isStartingBatch && (
        <div className="flex items-center gap-3 mb-6 bg-amber-100 p-3 rounded-xl border border-amber-200">
            <button type="button" onClick={onBackToFavorites} className="p-2 bg-amber-200 rounded-full text-amber-800 hover:bg-amber-300">
                <ArrowLeft className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-semibold text-amber-900">Adjust Recipe Before Batching</h2>
        </div>
      )}

      <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 shadow-sm">
        <h2 className="text-xl font-bold text-amber-900 mb-4 flex items-center">
          <Scale className="w-5 h-5 mr-2" />
          {isStartingBatch ? `Recipe: ${recipeName}` : 'Mead Calculator (Metric)'}
        </h2>
        
        {/* Toggle Path */}
        <div className="flex bg-amber-200 p-1 rounded-lg mb-6">
          <button 
            onClick={() => setMode('target')}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${mode === 'target' ? 'bg-white text-amber-900 shadow' : 'text-amber-800'}`}
          >
            Target ABV
          </button>
          <button 
            onClick={() => setMode('ingredients')}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-all ${mode === 'ingredients' ? 'bg-white text-amber-900 shadow' : 'text-amber-800'}`}
          >
            Ingredients
          </button>
        </div>
        
        {/* Recipe Name Input */}
        <div className="mb-4">
          <label className="block text-sm font-semibold text-amber-800 mb-1">Recipe/Batch Name</label>
          <input 
            type="text"
            placeholder="Name this recipe..."
            value={recipeName}
            onChange={(e) => setRecipeName(e.target.value)}
            className="w-full p-3 border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none bg-white"
          />
        </div>

        {/* Common Inputs */}
        <div className="mb-4">
          <label className="block text-sm font-semibold text-amber-800 mb-1">Batch Volume (Liters)</label>
          <input 
            type="number" 
            // Fix: Cast to string or use 0 if state is '' for React's value prop 
            value={volume === '' ? '' : volume} 
            onChange={handleNumericChange(setVolume)}
            className="w-full p-3 border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none bg-white"
            step="0.5"
          />
        </div>

        {/* Path Specific Inputs */}
        {mode === 'target' ? (
          <div className="space-y-4 animate-fadeIn">
            <div>
              <label className="block text-sm font-semibold text-amber-800 mb-1">Target ABV (%)</label>
              <input 
                type="number" 
                value={targetAbv === '' ? '' : targetAbv} 
                onChange={handleNumericChange(setTargetAbv)}
                className="w-full p-3 border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none bg-white"
              />
            </div>
            
            <div className="mt-6 bg-white p-4 rounded-lg border border-amber-200">
              <h3 className="text-sm font-bold text-amber-600 uppercase tracking-wider mb-2">Results</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-amber-50 rounded text-center">
                  <div className="text-2xl font-bold text-amber-900">{calculations.honeyNeeded} kg</div>
                  <div className="text-xs text-amber-700">Honey Needed</div>
                </div>
                <div className="p-3 bg-amber-50 rounded text-center">
                  <div className="text-2xl font-bold text-amber-900">{calculations.og}</div>
                  <div className="text-xs text-amber-700">Target SG</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 animate-fadeIn">
            <div>
              <label className="block text-sm font-semibold text-amber-800 mb-1">Honey Amount (kg)</label>
              <input 
                type="number" 
                value={honeyAmount === '' ? '' : honeyAmount} 
                onChange={handleNumericChange(setHoneyAmount)}
                className="w-full p-3 border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none bg-white"
                step="0.1"
              />
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <label className="block text-sm font-semibold text-amber-800">Fruits & Additions</label>
                <button type="button" onClick={handleAddFruit} className="text-amber-600 hover:bg-amber-100 p-1 rounded">
                  <Plus className="w-5 h-5" />
                </button>
              </div>
              
              {fruits.map((fruit, idx) => (
                <div key={fruit.id} className="bg-white p-3 rounded-lg border border-amber-200 shadow-sm grid grid-cols-[1fr_9rem] gap-2 items-center">
                    
                    {/* Top Left: Dropdown */}
                    <select 
                      onChange={(e) => handleFruitPresetSelect(fruit.id, e.target.value)}
                      className="w-full p-2 border border-amber-300 rounded-lg text-sm bg-amber-50/50"
                      value={FRUIT_DATA.some(d => d.name === fruit.name) ? fruit.name : 'Custom'}
                    >
                      <option value="Custom">Custom Fruit...</option>
                      {FRUIT_DATA.filter(f => f.name !== 'Custom').map(f => (
                        <option key={f.name} value={f.name}>{f.name}</option>
                      ))}
                    </select>
                    
                    {/* Top Right: Weight + Delete */}
                    <div className="flex gap-2 items-center justify-end w-full">
                        <div className="relative flex-1">
                            <input 
                              type="number" 
                              placeholder="0" 
                              value={fruit.amount === '' ? '' : fruit.amount}
                              onChange={(e) => handleFruitChange(fruit.id, 'amount', e.target.value)}
                              className="w-full p-2 border border-amber-300 rounded-lg text-sm text-right pr-8"
                              step="0.1"
                            />
                            <span className="absolute right-2 top-2 text-xs text-gray-500">kg</span>
                        </div>

                        <button type="button" onClick={() => handleRemoveFruit(fruit.id)} className="text-red-400 hover:text-red-600 px-1 min-w-[20px]">
                          <Trash2 className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Bottom Left: Name */}
                    <input 
                      type="text" 
                      placeholder="Name (e.g. Mulberry)" 
                      value={fruit.name}
                      onChange={(e) => handleFruitChange(fruit.id, 'name', e.target.value)}
                      className="w-full p-1 px-2 border border-gray-200 rounded text-sm text-gray-700 placeholder:text-gray-300 h-9"
                    />
                    
                    {/* Bottom Right: Sugar % */}
                    <div className="flex items-center gap-1 bg-amber-50 px-2 rounded border border-amber-100 h-9 w-full" title="Sugar percentage by weight">
                      <span className="text-xs text-amber-600 font-bold whitespace-nowrap">Sugar</span>
                      <input 
                        type="number" 
                        value={fruit.sugarPercent === '' ? '' : fruit.sugarPercent}
                        onChange={(e) => handleFruitChange(fruit.id, 'sugarPercent', e.target.value)}
                        className="flex-1 min-w-0 p-1 bg-transparent text-right text-sm font-mono border-b border-amber-300 focus:outline-none"
                      />
                      <span className="text-xs text-amber-600">%</span>
                    </div>

                </div>
              ))}
            </div>

            <div className="mt-6 bg-white p-4 rounded-lg border border-amber-200">
              <h3 className="text-sm font-bold text-amber-600 uppercase tracking-wider mb-2">Estimates</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-amber-50 rounded text-center">
                  <div className="text-2xl font-bold text-amber-900">{calculations.abv}%</div>
                  <div className="text-xs text-amber-700">Est. ABV</div>
                </div>
                <div className="p-3 bg-amber-50 rounded text-center">
                  <div className="text-2xl font-bold text-amber-900">{calculations.og}</div>
                  <div className="text-xs text-amber-700">Est. OG</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Action Section */}
        <div className="mt-6 pt-6 border-t border-amber-200 flex flex-col gap-3">
          {!isStartingBatch && (
            <button 
                type="button"
                onClick={handleSave}
                disabled={isSaveDisabled}
                className="w-full bg-amber-600 text-white py-3 rounded-lg font-semibold hover:bg-amber-700 transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
                <Save className="w-5 h-5" />
                Save to Favorites (Planning)
            </button>
          )}

          {isStartingBatch && (
            <button 
                type="button"
                onClick={handleStartBatch}
                disabled={isSaveDisabled}
                className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
                <Droplet className="w-5 h-5" />
                Start Batch (Begin Brewing)
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// 2. Favorites List
const Favorites = ({ favorites, onDelete, onStartBatch }) => {
  if (favorites.length === 0) {
    return (
      <div className="text-center py-12 text-amber-800 opacity-60">
        <BookOpen className="w-12 h-12 mx-auto mb-2" />
        <p>No saved recipes yet (Planning stage).</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <h2 className="text-xl font-bold text-amber-900 mb-4 flex items-center">
        <BookOpen className="w-5 h-5 mr-2" />
        Recipe Cellar (Planning)
      </h2>
      {favorites.map(recipe => {
        
        // NEW: Format fruit list for display
        const fruitSummary = recipe.fruits && recipe.fruits.length > 0
          ? recipe.fruits.map(f => `${f.amount} kg ${f.name}`).join(', ')
          : null;

        return (
          <div key={recipe.id} className="bg-white p-4 rounded-xl shadow-sm border border-amber-100 flex flex-col gap-3">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-lg text-amber-900">{recipe.name}</h3>
                <p className="text-xs text-amber-600 uppercase tracking-wide">
                  {recipe.volume} L • {recipe.calculatedAbv}% ABV • {recipe.calculatedOg} SG
                </p>
              </div>
              <button type="button" onClick={() => onDelete(recipe.id)} className="text-gray-400 hover:text-red-500">
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
            
            <div className="text-sm text-gray-600 bg-amber-50 p-2 rounded">
              {recipe.mode === 'target' ? (
                // This is a rough display summary; the true calculated value is stored
                <span>Targeting <strong>{recipe.targetAbv}% ABV</strong>, {recipe.volume} L.</span>
              ) : (
                <span>
                  <strong>{recipe.honeyAmount} kg</strong> Honey
                  {fruitSummary && 
                    <span className="ml-1">
                      + {fruitSummary}
                    </span>
                  }
                </span>
              )}
            </div>

            <button 
              type="button"
              // Pass the entire recipe to onStartBatch which triggers the Calculator view load
              onClick={() => onStartBatch(recipe)} 
              className="w-full mt-2 py-2 bg-amber-100 text-amber-800 rounded-lg font-medium hover:bg-amber-200 transition flex items-center justify-center gap-2"
            >
              <Droplet className="w-4 h-4" />
              Start Batch (Brewing)
            </button>
          </div>
        )})}
    </div>
  );
};

// 3. Batches List & Detail
const Batches = ({ batches, onOpenBatch }) => {
  if (batches.length === 0) {
    return (
      <div className="text-center py-12 text-amber-800 opacity-60">
        <Activity className="w-12 h-12 mx-auto mb-2" />
        <p>No batches active. Start one from your Cellar!</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <h2 className="text-xl font-bold text-amber-900 mb-4 flex items-center">
        <Activity className="w-5 h-5 mr-2" />
        Batch Tracking
      </h2>
      {batches
        .sort((a, b) => safeGetDate(b.startDate).getTime() - safeGetDate(a.startDate).getTime()) // Sort newest first
        .map(batch => {
        const logs = batch.logs || [];
        const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
        const currentSG = lastLog ? lastLog.sg : batch.calculatedOg;
        const currentABV = sgToAbv(batch.calculatedOg, currentSG);
        
        // Safely get the start date, preventing the initial error
        const startDate = safeGetDate(batch.startDate);
        const status = batch.status || 'brewing';
        const statusConfig = BATCH_STATUSES[status] || BATCH_STATUSES.brewing;
        const StatusIcon = statusConfig.icon;


        return (
          <div 
            key={batch.id} 
            onClick={() => onOpenBatch(batch)}
            className="bg-white p-4 rounded-xl shadow-sm border border-amber-100 active:scale-95 transition-transform cursor-pointer"
          >
            <div className="flex justify-between items-start mb-2">
              <h3 className="font-bold text-lg text-amber-900">{batch.name}</h3>
              <ChevronRight className="w-5 h-5 text-amber-400" />
            </div>

            {/* Status Label */}
            <div className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full mb-3 ${statusConfig.color} border`}>
                <StatusIcon className="w-3 h-3 mr-1" />
                {statusConfig.label}
            </div>
            
            <div className="flex gap-4 text-sm mb-3">
              <div className="flex-1 bg-amber-50 p-2 rounded text-center">
                <span className="block text-xs text-amber-600 uppercase">Original SG</span>
                <span className="font-mono font-bold text-amber-900">{batch.calculatedOg}</span>
              </div>
              <div className="flex-1 bg-green-50 p-2 rounded text-center">
                <span className="block text-xs text-green-600 uppercase">Current SG</span>
                <span className="font-mono font-bold text-green-900">{currentSG}</span>
              </div>
              <div className="flex-1 bg-purple-50 p-2 rounded text-center">
                <span className="block text-xs text-purple-600 uppercase">Curr. ABV</span>
                <span className="font-mono font-bold text-purple-900">{currentABV}%</span>
              </div>
            </div>

            <div className="flex items-center text-xs text-gray-500">
              <Calendar className="w-3 h-3 mr-1" />
              Started: {startDate.toLocaleDateString()}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const BatchDetail = ({ batch, userId, onBack, onUpdateBatch }) => {
  const [newSg, setNewSg] = useState('');
  const [note, setNote] = useState('');
  const [isAddingLog, setIsAddingLog] = useState(false);
  const [editingLog, setEditingLog] = useState(null); // The index of the log being edited
  const currentStatus = batch.status || 'brewing';
  const statusConfig = BATCH_STATUSES[currentStatus] || BATCH_STATUSES.brewing;

  const logs = batch.logs || [];
  // Sort logs: Newest first
  const sortedLogs = useMemo(() => {
    return [...logs].sort((a, b) => {
      const dateA = safeGetDate(a.date).getTime();
      const dateB = safeGetDate(b.date).getTime();
      return dateB - dateA;
    }); 
  }, [logs]);
  
  const lastLog = sortedLogs.length > 0 ? sortedLogs[0] : null;
  const currentSG = lastLog ? lastLog.sg : batch.calculatedOg;
  const currentABV = sgToAbv(batch.calculatedOg, currentSG);

  // Safely get the start date
  const startDate = safeGetDate(batch.startDate);

  // Function to handle saving/editing logs
  const handleSaveLog = async (logIndex = -1) => {
    const sgValue = parseFloat(newSg);
    if (isNaN(sgValue) || sgValue < 0.990 || sgValue > 1.200) {
        // IMPORTANT: Custom modal UI should be used here instead of alert()
        alert("Please enter a valid Specific Gravity (e.g., between 0.990 and 1.200).");
        return;
    }
    
    // Check if we are editing or adding
    const isEdit = logIndex !== -1;

    // The date input for editing is YYYY-MM-DD, convert back to ISO string
    const logDate = isEdit ? new Date(editingLog.date).toISOString() : new Date().toISOString(); 
    
    const logToSave = {
      sg: sgValue.toFixed(3),
      note: note,
      date: logDate 
    };

    let updatedLogs = [...logs];

    if (isEdit) {
        // Edit existing log
        updatedLogs[logIndex] = logToSave;
    } else {
        // Add new log
        updatedLogs = [...logs, logToSave];
    }
    
    // Optimistic local update 
    onUpdateBatch(batch.id, { logs: updatedLogs });

    // Close form/editing mode
    setIsAddingLog(false);
    setEditingLog(null);
    setNewSg('');
    setNote('');

    // Update Firestore
    try {
      const batchRef = doc(db, 'artifacts', appId, 'users', userId, 'batches', batch.id);
      await updateDoc(batchRef, { logs: updatedLogs });
    } catch (error) {
      console.error("Error updating batch", error);
    }
  };

  const handleDeleteLog = async (logIndex) => {
      // IMPORTANT: Custom modal UI should be used here instead of confirm()
      if (!window.confirm("Are you sure you want to delete this specific gravity reading?")) return;

      const updatedLogs = logs.filter((_, idx) => idx !== logIndex);

      // Optimistic local update 
      onUpdateBatch(batch.id, { logs: updatedLogs });
      setEditingLog(null); // Exit editing mode if we delete the item being edited

      try {
        const batchRef = doc(db, 'artifacts', appId, 'users', userId, 'batches', batch.id);
        await updateDoc(batchRef, { logs: updatedLogs });
      } catch (error) {
        console.error("Error deleting log entry", error);
      }
  };

  const handleEditClick = (logIndex, log) => {
      // Find the original index from the main `logs` array, not the sorted one
      // The log date/sg is used as a unique identifier for finding the original index in the unsorted array
      const originalIndex = logs.findIndex(l => safeGetDate(l.date).getTime() === safeGetDate(log.date).getTime() && l.sg === log.sg);

      if (originalIndex !== -1) {
          setEditingLog({ ...log, index: originalIndex });
          setNewSg(parseFloat(log.sg));
          setNote(log.note);
          setIsAddingLog(false); // Make sure the add form is closed
      }
  };

  const handleDeleteBatch = async () => {
    // IMPORTANT: Custom modal UI should be used here instead of confirm()
    if(window.confirm("Are you sure you want to delete this batch? This cannot be undone.")) {
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'users', userId, 'batches', batch.id));
            onBack();
        } catch(e) {
            console.error("Error deleting batch:", e);
        }
    }
  }

  const handleSgChange = (e) => {
    const value = e.target.value;
    setNewSg(value === '' ? '' : parseFloat(value));
  };
  
  const handleStatusChange = async (e) => {
      const newStatus = e.target.value;
      // Optimistic UI update
      onUpdateBatch(batch.id, { status: newStatus }); 
      try {
          const batchRef = doc(db, 'artifacts', appId, 'users', userId, 'batches', batch.id);
          await updateDoc(batchRef, { status: newStatus });
      } catch(e) {
          console.error("Error updating status:", e);
      }
  }


  // Log index is the original index in the 'logs' array, not the sorted array
  const currentLogIndex = editingLog?.index; 
  
  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button type="button" onClick={onBack} className="p-2 bg-amber-100 rounded-full text-amber-800 hover:bg-amber-200">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-xl font-bold text-amber-900">{batch.name}</h2>
          <p className="text-xs text-amber-600">Started {startDate.toLocaleDateString()}</p>
        </div>
      </div>
      
      {/* Status Selector */}
      <div className="bg-white p-4 rounded-xl border border-amber-200 shadow-sm">
        <label className="text-sm font-bold text-amber-700 uppercase block mb-2 flex items-center">
            <Wand2 className="w-4 h-4 mr-2" />
            Batch Status
        </label>
        <select
            value={currentStatus}
            onChange={handleStatusChange}
            className={`w-full p-3 rounded-lg font-semibold border-2 transition-colors ${statusConfig.color} border-${statusConfig.color.match(/border-(\w+-\d+)/)?.[1] || 'amber-200'}`}
        >
            {BATCH_STATUS_OPTIONS.map(key => (
                <option key={key} value={key}>
                    {BATCH_STATUSES[key].label}
                </option>
            ))}
        </select>
      </div>


      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white p-3 rounded-xl border border-amber-100 shadow-sm text-center">
            <div className="text-xs text-amber-500 uppercase font-bold mb-1">OG</div>
            <div className="font-mono text-lg font-bold text-amber-900">{batch.calculatedOg}</div>
        </div>
        <div className="bg-green-50 p-3 rounded-xl border border-green-100 shadow-sm text-center">
            <div className="text-xs text-green-600 uppercase font-bold mb-1">Gravity</div>
            <div className="font-mono text-lg font-bold text-green-900">{currentSG}</div>
        </div>
        <div className="bg-purple-50 p-3 rounded-xl border border-purple-100 shadow-sm text-center">
            <div className="text-xs text-purple-600 uppercase font-bold mb-1">ABV</div>
            <div className="font-mono text-lg font-bold text-purple-900">{currentABV}%</div>
        </div>
      </div>

      {/* Add/Edit Log Section */}
      {!isAddingLog && !editingLog ? (
        <button 
          type="button"
          onClick={() => setIsAddingLog(true)}
          className="w-full py-3 bg-amber-600 text-white rounded-xl font-semibold shadow-sm hover:bg-amber-700 transition flex justify-center items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          Add Gravity Reading
        </button>
      ) : (
        <div className="bg-white p-4 rounded-xl border border-amber-200 shadow-sm animate-fadeIn">
          <h3 className="font-bold text-amber-900 mb-3">{editingLog ? 'Edit Reading' : 'New Reading'}</h3>
          <div className="flex gap-3 mb-3">
             <div className="flex-1">
                <label className="text-xs font-bold text-amber-700 uppercase block mb-1">Specific Gravity</label>
                <input 
                  type="number" 
                  step="0.001" 
                  placeholder="1.000"
                  value={newSg === '' ? '' : newSg} 
                  onChange={handleSgChange}
                  className="w-full p-2 border border-amber-300 rounded-lg font-mono"
                />
             </div>
             {editingLog && (
                <div className="flex-1">
                    <label className="text-xs font-bold text-amber-700 uppercase block mb-1">Date</label>
                    <input 
                        type="date"
                        value={formatDate(editingLog.date)}
                        onChange={(e) => setEditingLog({...editingLog, date: e.target.value})}
                        className="w-full p-2 border border-amber-300 rounded-lg text-sm"
                    />
                </div>
             )}
          </div>
          <div className="mb-3">
            <label className="text-xs font-bold text-amber-700 uppercase block mb-1">Notes</label>
            <textarea 
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Tasting notes, visual changes..."
              className="w-full p-2 border border-amber-300 rounded-lg text-sm h-20"
            />
          </div>
          <div className="flex gap-2">
            <button 
              type="button"
              onClick={() => {
                setIsAddingLog(false);
                setEditingLog(null);
                setNewSg('');
                setNote('');
              }}
              className="flex-1 py-2 bg-gray-100 text-gray-700 rounded-lg font-medium"
            >
              Cancel
            </button>
            <button 
              type="button"
              onClick={() => handleSaveLog(currentLogIndex)}
              disabled={!newSg || parseFloat(newSg) < 0.990 || parseFloat(newSg) > 1.200}
              className="flex-1 py-2 bg-amber-600 text-white rounded-lg font-medium disabled:opacity-50"
            >
              {editingLog ? 'Update Log' : 'Save Log'}
            </button>
            {editingLog && (
                <button
                    type="button"
                    onClick={() => handleDeleteLog(currentLogIndex)}
                    className="p-2 bg-red-100 text-red-600 rounded-lg"
                    title="Delete this reading"
                >
                    <Trash2 className="w-5 h-5" />
                </button>
            )}
          </div>
        </div>
      )}

      {/* History Timeline */}
      <div className="relative border-l-2 border-amber-200 ml-3 pl-6 space-y-6">
        {sortedLogs.map((log, idx) => (
          // We use the original date/sg combination as a unique key since we don't store log IDs
          <div key={safeGetDate(log.date).getTime() + log.sg} className="relative">
            <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-amber-400 border-2 border-white shadow-sm"></div>
            <div className="flex justify-between items-start mb-1">
               <span className="font-mono font-bold text-amber-900">{log.sg} SG</span>
               <div className="flex items-center gap-2">
                 <span className="text-xs text-gray-500">
                   {safeGetDate(log.date).toLocaleDateString()}
                 </span>
                 <button 
                    onClick={() => handleEditClick(idx, log)}
                    className="text-amber-500 hover:text-amber-700 p-1 rounded-full bg-amber-50/50"
                    title="Edit Reading"
                 >
                    <Pencil className="w-4 h-4" />
                 </button>
               </div>
            </div>
            {log.note && <p className="text-sm text-gray-600 bg-amber-50 p-2 rounded-lg">{log.note}</p>}
          </div>
        ))}
        {/* Start Node */}
        <div className="relative">
            <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-amber-900 border-2 border-white shadow-sm"></div>
            <div className="mb-1">
               <span className="font-bold text-amber-900">Brew Day</span>
            </div>
            <p className="text-sm text-gray-600">Batch created with OG {batch.calculatedOg}</p>
        </div>
      </div>
        
      <button type="button" onClick={handleDeleteBatch} className="w-full mt-8 py-3 text-red-400 text-sm hover:text-red-600 hover:bg-red-50 rounded-lg">
        Delete Batch
      </button>

    </div>
  );
};

// --- Main App Component ---
export default function App() {
  const [user, setUser] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [view, setView] = useState('calc'); // 'calc', 'favorites', 'batches', 'batch-detail'
  const [favorites, setFavorites] = useState([]);
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [loadRecipe, setLoadRecipe] = useState(null); // Recipe data loaded from Favorites to edit before batching
  const [isStartingBatch, setIsStartingBatch] = useState(false); // Flag if we are using calculator to start a batch

  // Auth & Data Listeners
  useEffect(() => {
    const initAuth = async () => {
        try {
            if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                await signInWithCustomToken(auth, __initial_auth_token);
            } else {
                await signInAnonymously(auth);
            }
        } catch (e) {
             console.error("Auth failed:", e);
             // Fallback to anonymous if custom token fails
             await signInAnonymously(auth);
        }
    };
    initAuth();

    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribeAuth();
  }, []);

  const userId = user?.uid;

  useEffect(() => {
    if (!userId || !isAuthReady) return;

    // Listen to Favorites
    const favUnsub = onSnapshot(collection(db, 'artifacts', appId, 'users', userId, 'favorites'), 
      (snapshot) => {
        const favs = snapshot.docs.map(d => ({id: d.id, ...d.data()}));
        setFavorites(favs);
      },
      (error) => console.error("Error fetching favorites:", error)
    );

    // Listen to Batches
    const batchUnsub = onSnapshot(collection(db, 'artifacts', appId, 'users', userId, 'batches'), 
      (snapshot) => {
        const b = snapshot.docs.map(d => ({id: d.id, ...d.data()}));
        setBatches(b);
        // Ensure selectedBatch remains updated if changes occur in the background
        if (selectedBatch) {
            const updatedSelected = b.find(batch => batch.id === selectedBatch.id);
            if (updatedSelected) {
                setSelectedBatch(updatedSelected);
            } else if (!updatedSelected && view === 'batch-detail') {
                // If the selected batch was deleted by another client, go back to the list
                setView('batches');
            }
        }
      },
      (error) => console.error("Error fetching batches:", error)
    );

    return () => {
      favUnsub();
      batchUnsub();
    };
  }, [userId, isAuthReady, selectedBatch, view]);

  // Actions
  const saveRecipe = async (recipeData) => {
    if (!userId) return;
    try {
      await addDoc(collection(db, 'artifacts', appId, 'users', userId, 'favorites'), recipeData);
      // Only show confirmation if we are not in the process of starting a batch
      if (!isStartingBatch) {
        // IMPORTANT: Custom modal UI should be used here instead of alert()
        alert("Recipe Saved! (Planning stage)"); 
      }
    } catch (e) {
      console.error(e);
      // IMPORTANT: Custom modal UI should be used here instead of alert()
      alert("Error saving recipe"); 
    }
  };

  const deleteFavorite = async (id) => {
    if (!userId) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'users', userId, 'favorites', id));
    } catch(e) { console.error(e); }
  };

  const startBatchPrep = (recipe) => {
    setLoadRecipe(recipe);
    setIsStartingBatch(true);
    setView('calc');
  }

  const startBatch = async (batchData) => {
    if (!userId) return;
    
    // Check if the recipe had an ID (meaning it came from Favorites)
    const originalRecipeId = batchData.id;

    try {
      const finalBatchData = {
        ...batchData,
        // Safely set originalRecipeId if it exists (avoids saving 'undefined')
        ...(originalRecipeId && { originalRecipeId: originalRecipeId }), 
        startDate: serverTimestamp(), 
        logs: [], // Array of { date, sg, note }
        status: 'brewing' // Initial stage set to 'brewing'
      };
      
      // Remove the temporary 'id' from the object before saving to Firestore, 
      // as Firestore assigns a new one for the batch document.
      delete finalBatchData.id; 
      
      await addDoc(collection(db, 'artifacts', appId, 'users', userId, 'batches'), finalBatchData);
      
      // Reset state and switch view
      setIsStartingBatch(false);
      setLoadRecipe(null);
      setView('batches');
    } catch (e) {
      console.error(e);
      // IMPORTANT: Custom modal UI should be used here instead of alert()
      alert("Error starting batch");
    }
  };

  const openBatch = (batch) => {
    setSelectedBatch(batch);
    setView('batch-detail');
  };

  const handleBackToFavorites = () => {
    setIsStartingBatch(false);
    setLoadRecipe(null);
    setView('favorites');
  }

  if (!isAuthReady) {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-amber-50">
            <Wine className="w-12 h-12 text-amber-500 animate-pulse" />
            <p className="mt-3 text-lg text-amber-800">Loading the Cellar...</p>
        </div>
    );
  }

  // Main Render
  return (
    <div className="max-w-md mx-auto h-screen bg-amber-50/50 flex flex-col font-sans text-amber-950">
      {/* Header */}
      <header className="bg-amber-600 text-white p-4 shadow-xl z-10 sticky top-0">
        <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold flex items-center gap-2">
                <Wine className="w-6 h-6" />
                Golden Drop
            </h1>
            {userId && <span className="text-xs bg-amber-700 px-2 py-1 rounded-full opacity-80">User ID: {userId.slice(0, 8)}...</span>}
        </div>
      </header>

      {/* Content Area */}
      <main className="flex-1 overflow-y-auto p-4 scroll-smooth">
        {view === 'calc' && (
          <Calculator 
            onSave={saveRecipe} 
            onStartBatch={startBatch}
            initialData={loadRecipe} 
            isStartingBatch={isStartingBatch}
            onBackToFavorites={handleBackToFavorites}
          />
        )}
        {view === 'favorites' && (
          <Favorites 
            favorites={favorites} 
            onDelete={deleteFavorite} 
            onStartBatch={startBatchPrep} 
          />
        )}
        {view === 'batches' && (
          <Batches batches={batches} onOpenBatch={openBatch} />
        )}
        {view === 'batch-detail' && selectedBatch && (
          <BatchDetail 
            batch={selectedBatch} 
            userId={userId} 
            onBack={() => setView('batches')} 
            onUpdateBatch={(id, data) => {
                // Optimistic update for UI
                setSelectedBatch({...selectedBatch, ...data});
            }}
          />
        )}
      </main>

      {/* Bottom Nav */}
      <nav className="bg-white border-t border-amber-200 p-2 grid grid-cols-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] sticky bottom-0 z-10">
        <button 
          onClick={() => {
            setView('calc');
            setIsStartingBatch(false); // Make sure we go to the clean calculator
            setLoadRecipe(null);
          }}
          className={`flex flex-col items-center p-2 rounded-lg transition ${view === 'calc' && !isStartingBatch ? 'text-amber-600 bg-amber-50' : 'text-gray-400 hover:text-amber-500'}`}
        >
          <Scale className="w-6 h-6 mb-1" />
          <span className="text-[10px] font-bold uppercase">Brew</span>
        </button>
        <button 
          onClick={() => setView('favorites')}
          className={`flex flex-col items-center p-2 rounded-lg transition ${view === 'favorites' ? 'text-amber-600 bg-amber-50' : 'text-gray-400 hover:text-amber-500'}`}
        >
          <BookOpen className="w-6 h-6 mb-1" />
          <span className="text-[10px] font-bold uppercase">Cellar</span>
        </button>
        <button 
          onClick={() => setView('batches')}
          className={`flex flex-col items-center p-2 rounded-lg transition ${view === 'batches' || view === 'batch-detail' ? 'text-amber-600 bg-amber-50' : 'text-gray-400 hover:text-amber-500'}`}
        >
          <Activity className="w-6 h-6 mb-1" />
          <span className="text-[10px] font-bold uppercase">Active</span>
        </button>
      </nav>
    </div>
  );
}
