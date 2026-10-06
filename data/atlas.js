// Land Conversion Atlas data (land.html)
// crops: salinity tolerance from FAO Irrigation and Drainage Paper 61, Annex 1 (threshold T in dS/m and slope b in % yield lost per dS/m).
//   Relative yield = 100 - b * (ECe - T) when ECe > T.
//   est:true rows (halophytes, quinoa, salt-tolerant potato) use approximate values from field programmes, not the FAO table.
// pH, rainfall (mm/yr, rainfed) and mean annual temperature (degC) ranges are approximate agronomic ranges in the style of FAO ECOCROP.
// use: food | forage | oil | fibre | tree | metal. irrig: true = needs irrigation or groundwater almost everywhere.
// cool: true = can be grown as a winter (cool-season) crop where the annual mean is warmer than its range, as in the Indo-Gangetic plain.

window.ATLAS = {
  crops: [
    { id: "barley", cool: true, name: "Barley", use: "food", T: 8.0, b: 5.0, ph: [6.0, 8.5], rain: [250, 800], temp: [3, 22], src: "fao61" },
    { id: "wheatsd", cool: true, name: "Wheat (semi-dwarf)", use: "food", T: 8.6, b: 3.0, ph: [5.5, 8.5], rain: [300, 900], temp: [5, 22], src: "fao61" },
    { id: "wheat", cool: true, name: "Wheat", use: "food", T: 6.0, b: 7.1, ph: [5.5, 8.0], rain: [300, 900], temp: [5, 22], src: "fao61" },
    { id: "durum", cool: true, name: "Durum wheat", use: "food", T: 5.9, b: 3.8, ph: [6.0, 8.5], rain: [300, 700], temp: [8, 22], src: "fao61" },
    { id: "rye", name: "Rye", use: "food", T: 11.4, b: 10.8, ph: [5.0, 7.5], rain: [300, 900], temp: [2, 18], src: "fao61" },
    { id: "triticale", cool: true, name: "Triticale", use: "food", T: 6.1, b: 2.5, ph: [5.0, 8.0], rain: [300, 900], temp: [4, 20], src: "fao61" },
    { id: "sorghum", name: "Sorghum", use: "food", T: 6.8, b: 16, ph: [5.5, 8.5], rain: [400, 1100], temp: [18, 32], src: "fao61" },
    { id: "millet", name: "Pearl millet", use: "food", T: 6.0, b: 10, ph: [5.0, 8.0], rain: [250, 700], temp: [20, 32], est: true, src: "ecocrop" },
    { id: "rice", name: "Rice (paddy)", use: "food", T: 3.0, b: 12, ph: [4.5, 7.5], rain: [1200, 3500], temp: [18, 32], wet: true, src: "fao61" },
    { id: "ricest", name: "Salt-tolerant rice", use: "food", T: 6.0, b: 9, ph: [4.5, 8.5], rain: [1200, 3500], temp: [18, 32], wet: true, est: true, src: "cssri" },
    { id: "maize", name: "Maize", use: "food", T: 1.7, b: 12, ph: [5.5, 7.5], rain: [500, 1500], temp: [14, 30], src: "fao61" },
    { id: "soy", name: "Soybean", use: "food", T: 5.0, b: 20, ph: [6.0, 7.5], rain: [450, 1200], temp: [15, 28], src: "fao61" },
    { id: "cowpea", name: "Cowpea", use: "food", T: 4.9, b: 12, ph: [5.5, 7.5], rain: [300, 1000], temp: [20, 32], src: "fao61" },
    { id: "groundnut", name: "Groundnut", use: "food", T: 3.2, b: 29, ph: [5.5, 7.0], rain: [500, 1200], temp: [20, 30], src: "fao61" },
    { id: "potato", cool: true, name: "Potato", use: "food", T: 1.7, b: 12, ph: [4.8, 6.5], rain: [400, 900], temp: [5, 20], src: "fao61" },
    { id: "potatost", cool: true, name: "Salt-tolerant potato", use: "food", T: 5.0, b: 6, ph: [4.8, 7.5], rain: [400, 900], temp: [5, 22], est: true, src: "texel" },
    { id: "quinoa", cool: true, name: "Quinoa", use: "food", T: 10, b: 3, ph: [6.0, 8.5], rain: [250, 700], temp: [5, 22], est: true, src: "ecocrop" },
    { id: "cassava", name: "Cassava", use: "food", T: 3.0, b: 10, ph: [4.5, 7.5], rain: [900, 2500], temp: [20, 30], est: true, src: "ecocrop" },
    { id: "sugarbeet", cool: true, name: "Sugar beet", use: "food", T: 7.0, b: 5.9, ph: [6.5, 8.0], rain: [450, 900], temp: [6, 20], src: "fao61" },
    { id: "datepalm", name: "Date palm", use: "tree", T: 4.0, b: 3.6, ph: [6.5, 8.5], rain: [0, 250], temp: [20, 32], irrig: true, src: "fao61" },
    { id: "cotton", name: "Cotton", use: "fibre", T: 7.7, b: 5.2, ph: [5.8, 8.0], rain: [500, 1200], temp: [18, 30], src: "fao61" },
    { id: "sunflower", name: "Sunflower", use: "oil", T: 4.8, b: 5.0, ph: [6.0, 8.0], rain: [400, 900], temp: [12, 26], src: "fao61" },
    { id: "wheatgrass", name: "Tall wheatgrass", use: "forage", T: 7.5, b: 4.2, ph: [6.0, 9.0], rain: [300, 700], temp: [6, 22], src: "fao61" },
    { id: "bermuda", name: "Bermudagrass", use: "forage", T: 6.9, b: 6.4, ph: [5.5, 8.5], rain: [500, 1500], temp: [16, 30], src: "fao61" },
    { id: "puccinellia", name: "Puccinellia", use: "forage", T: 15, b: 3.5, ph: [6.5, 9.5], rain: [250, 600], temp: [8, 22], est: true, src: "saltbush" },
    { id: "saltbush", name: "Old man saltbush", use: "forage", T: 20, b: 2.5, ph: [6.5, 9.5], rain: [150, 500], temp: [10, 26], est: true, src: "saltbush" },
    { id: "kallar", name: "Kallar grass", use: "forage", T: 12, b: 3, ph: [7.0, 10.0], rain: [200, 900], temp: [18, 32], est: true, src: "cssri" },
    { id: "salicornia", name: "Salicornia", use: "oil", T: 30, b: 2, ph: [6.5, 9.0], rain: [0, 600], temp: [16, 32], irrig: true, est: true, src: "icba" },
    { id: "melaleuca", name: "Melaleuca (paperbark)", use: "tree", T: 6, b: 4, ph: [3.0, 7.0], rain: [1000, 3000], temp: [20, 30], wet: true, est: true, src: "ecocrop" },
    { id: "oilpalm", name: "Oil palm", use: "oil", T: 3.0, b: 10, ph: [4.0, 6.5], rain: [1800, 3500], temp: [24, 29], est: true, src: "ecocrop" },
    { id: "odontarrhena", name: "Odontarrhena (Ni hyperaccumulator)", use: "metal", T: 4, b: 10, ph: [5.5, 8.0], rain: [450, 1300], temp: [7, 18], ultra: true, est: true, src: "agromining" },
    { id: "berkheya", name: "Berkheya coddii (Ni hyperaccumulator)", use: "metal", T: 4, b: 10, ph: [5.0, 7.5], rain: [550, 1100], temp: [14, 24], ultra: true, est: true, src: "phytomining" },
    { id: "phyllanthus", name: "Phyllanthus rufuschaneyi (Ni hyperaccumulator)", use: "metal", T: 3, b: 10, ph: [4.5, 7.5], rain: [1800, 4000], temp: [21, 29], ultra: true, est: true, src: "phyllanthus" }
  ],

  // Mapped marginal-land zones (approximate centres and radii for orientation, not survey boundaries).
  // ec: typical root-zone ECe in dS/m (est). ph: typical topsoil pH (est).
  zones: [
    { id: "wa-salt", name: "WA wheatbelt saline valley floors", land: "saline", at: [117.6, -31.6], r: 220, ec: 12, note: "1 to 2 Mha salt-affected, rising saline water tables after clearing", project: "waSalt" },
    { id: "mdb-salt", name: "Murray-Darling irrigation salinity", land: "saline", at: [143.9, -35.6], r: 150, ec: 8, note: "Irrigation-driven salinity in the Kerang and Riverland districts" },
    { id: "kambalda", name: "Kambalda-Leinster ultramafic belt", land: "ultramafic", at: [121.7, -30.5], r: 220, ec: 6, note: "Komatiite nickel belt in the Yilgarn. Arid, saline and ultramafic at once", project: null },
    { id: "sabah", name: "Ranau ultramafics, Sabah", land: "ultramafic", at: [116.6, 6.0], r: 70, ec: 0.5, note: "Site of the first tropical nickel agromining trials", project: "sabah" },
    { id: "albania", name: "Pojskë and Pindus ophiolite", land: "ultramafic", at: [20.6, 40.9], r: 120, ec: 0.6, note: "Serpentine farmland used for Odontarrhena trials", project: "albania" },
    { id: "newcal", name: "New Caledonia massif", land: "ultramafic", at: [165.5, -21.5], r: 160, ec: 0.6, note: "About a third of the main island is ultramafic, with large nickel mines" },
    { id: "sulawesi", name: "Morowali and Pomalaa, Sulawesi", land: "tailings", at: [122.0, -3.3], r: 180, ec: 1, note: "Laterite nickel mining and HPAL plants from the Ledger's nickel lane" },
    { id: "halmahera", name: "Weda Bay, Halmahera", land: "ultramafic", at: [127.9, 0.5], r: 90, ec: 0.6, note: "Ultramafic laterite under active nickel mining" },
    { id: "moa", name: "Moa, eastern Cuba", land: "ultramafic", at: [-74.9, 20.6], r: 70, ec: 0.6, note: "Serpentine plateau and laterite nickel" },
    { id: "klamath", name: "Klamath and Coast Range serpentine, California", land: "ultramafic", at: [-123.4, 41.3], r: 160, ec: 0.5, note: "Native nickel hyperaccumulators confirmed in California and Oregon" },
    { id: "greatdyke", name: "Great Dyke, Zimbabwe", land: "ultramafic", at: [30.6, -18.5], r: 200, ec: 0.8, note: "Long ultramafic intrusion with native Berkheya-type flora" },
    { id: "oman", name: "Semail ophiolite, Oman", land: "ultramafic", at: [57.5, 23.2], r: 160, ec: 4, note: "Hyperarid ultramafic mountains" },
    { id: "igp-sodic", name: "Indo-Gangetic sodic belt", land: "sodic", at: [79.5, 27.0], r: 300, ec: 4, ph: 9.6, note: "2.07 Mha reclaimed with gypsum, more still barren", project: "sodicIndia" },
    { id: "punjab-salt", name: "Salt-affected Punjab, Pakistan", land: "saline", at: [72.6, 31.2], r: 220, ec: 8, note: "Waterlogging and salinity in the canal command areas", project: "saltPotato" },
    { id: "bd-coast", name: "Coastal Bangladesh", land: "saline", at: [89.5, 22.3], r: 120, ec: 9, note: "Seawater intrusion and cyclone surges in the dry season" },
    { id: "mekong-acid", name: "Plain of Reeds and Long Xuyen, Mekong", land: "acid", at: [105.5, 10.6], r: 120, ec: 1.5, ph: 3.8, note: "Acid sulfate soils opened to rice with canals and shallow drainage" },
    { id: "iraq-salt", name: "Lower Mesopotamian plain", land: "saline", at: [46.3, 31.5], r: 200, ec: 12, note: "Ancient irrigation salinity. Large share of farmland affected" },
    { id: "aral", name: "Karakalpakstan and the Aral basin", land: "saline", at: [59.5, 43.0], r: 250, ec: 10, note: "Salt from the dried Aral Sea bed and over-irrigation" },
    { id: "uae-coast", name: "Gulf coastal sabkha", land: "saline", at: [54.5, 24.2], r: 160, ec: 40, note: "Salt flats with seawater on hand. Halophyte and aquaculture country", project: "icba" },
    { id: "salado", name: "Salado basin, Argentina", land: "sodic", at: [-59.0, -36.0], r: 220, ec: 6, ph: 9.0, note: "Flooding pampas with saline-sodic soils" },
    { id: "niger-sahel", name: "Maradi and Zinder, Niger", land: "degraded", at: [7.5, 13.6], r: 220, ec: 0.5, note: "Regreened by farmer-managed natural regeneration", project: "fmnr" },
    { id: "senegal-ggw", name: "Ferlo, Senegal", land: "degraded", at: [-14.5, 15.4], r: 200, ec: 1, note: "Great Green Wall planting zone", project: "ggw" },
    { id: "tigray", name: "Eastern Tigray highlands", land: "degraded", at: [39.6, 13.8], r: 120, ec: 0.5, note: "Exclosures and check dams recharged groundwater", project: "abreha" },
    { id: "loess", name: "Loess Plateau", land: "degraded", at: [109.0, 37.0], r: 350, ec: 1, note: "Terracing and grazing bans doubled farm incomes", project: "loess" },
    { id: "kubuqi", name: "Kubuqi Desert", land: "dune", at: [108.3, 40.3], r: 150, ec: 2, note: "About a third of the desert reported revegetated", project: "kubuqi" },
    { id: "portaugusta", name: "Upper Spencer Gulf", land: "dune", at: [137.8, -32.5], r: 80, ec: 6, note: "Arid coast with seawater. Site of Sundrop Farms", project: "sundrop" },
    { id: "xochimilco", name: "Xochimilco", land: "wetland", at: [-99.1, 19.26], r: 25, ec: 1.5, note: "Surviving chinampa zone in Mexico City", project: null }
  ],

  presets: ["wa-salt", "kambalda", "sabah", "albania", "sulawesi", "igp-sodic", "punjab-salt", "bd-coast", "mekong-acid", "uae-coast", "niger-sahel", "loess"],

  colors: { saline: "#2a78d6", sodic: "#9085e9", ultramafic: "#1baf7a", tailings: "#e34948", acid: "#eda100", dune: "#eb6834", degraded: "#b07a4a", wetland: "#3fb6c9" },

  sources: {
    fao61: { t: "FAO Irrigation and Drainage Paper 61, Annex 1: Crop salt tolerance data", u: "https://www.fao.org/4/y4263e/y4263e0e.htm" },
    ecocrop: { t: "FAO ECOCROP crop environmental requirements (approximate ranges)", u: "https://gaez.fao.org/pages/ecocrop" },
    soilgrids: { t: "ISRIC SoilGrids 2.0 (WMS and REST point query)", u: "https://www.isric.org/explore/soilgrids" },
    openmeteo: { t: "Open-Meteo historical weather API (ERA5)", u: "https://open-meteo.com/en/docs/historical-weather-api" },
    cssri: { t: "ICAR-CSSRI salt and sodicity tolerant varieties", u: "https://cssri.res.in/technology/" }
  }
};
