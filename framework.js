const ManiaEngine = {
	canvas: null,
	ctx: null,
	score: 0,
	combo: 0,
	laneWidth: 60,
	hitPosition: 500,
	activeNotes: [],
	parseOsu: function (osuText) {
		this.activeNotes = [];
		if (!osuText) {
			console.error(
				"parser tracking drop: text buffer payload is empty",
			);
			return;
		}
		const lines = osuText.split(/\r?\n/);
		let isHitObjectsSection = false;
		let keyCount = 4;
		for (let line of lines) {
			let cleanLine = line.trim();
			if (cleanLine.startsWith("CircleSize:")) {
				keyCount = parseInt(cleanLine.split(":")[1]) || 4;
				console.log('detected map key count: ' + keyCount + "K");
			}
		}
		for (let line of lines) {
			line = line.trim();
			if (!line) continue;
			if (line === "[HitObjects]") {
				isHitObjectsSection = true;
				continue;
			}
			if (isHitObjectsSection && line.startsWith("[")) {
				isHitObjectsSection = false;
			}
			if (isHitObjectsSection) {
				const parts = line.split(',');
				if (parts.length >= 3) {
					const rawX = parseInt(parts[0]) || 0;
					const time = parseInt(parts[2]) || 0;
					const type = parseInt(parts[3]) || 0;
					let lane = Math.floor(rawX * keyCount / 512);
					if (lane < 0) lane = 0;
					if (lane >= 4) lane = 3;
					if ((type & 128) === 128) {
						let endTimePart = parts[5] ? parts[5].split(':')[0] : time;
						let endTime = parseInt(endTimePart);
						if (isNaN(endTime) || endTime <= time) endTime = time + 1000;
						this.activeNotes.push({
							lane: lane,
							time: time,
							y: -100,
							hit: false,
							isLong: true,
							endTime: endTime,
							holdActive: false,
							completed: false,
						});
					} else {
						this.activeNotes.push({ lane: lane, time: time, y: -100, hit: false, isLong: false });
					}
				}
			}
		}
		this.activeNotes.sort((a, b) => a.time - b.time);
		console.log('parser summary: successfully complied ' + this.activeNotes.length + " visible timeline note blocks");
	},
	init: function (width, height) {
		this.canvas = document.createElement("canvas");
		this.canvas.width = width;
		this.canvas.height = height;
		document.body.appendChild(this.canvas);
		this.ctx = this.canvas.getContext("2d");
	},
	drawStage: function (startX, lanesNum) {
		this.ctx.fillStyle = "#222";
		this.ctx.fillRect(
			startX,
			0,
			lanesNum * this.laneWidth,
			this.canvas.height,
		);
		this.ctx.strokeStyle = "#444";
		this.ctx.lineWidth = 2;
		for (let i = 0; i <= lanesNum; i++) {
			let x = startX + i * this.laneWidth;
			this.ctx.beginPath();
			this.ctx.moveTo(x, 0);
			this.ctx.lineTo(x, this.canvas.height);
			this.ctx.stroke();
		}
		this.ctx.strokeStyle = "#fff";
		this.ctx.lineWidth = 4;
		this.ctx.beginPath();
		this.ctx.moveTo(startX, this.hitPosition);
		this.ctx.lineTo(startX + lanesNum * this.laneWidth, this.hitPosition);
		this.ctx.stroke();
	},
	drawNote: function (startX, lane, y, height, color) {
		let x = startX + lane * this.laneWidth;
		this.ctx.fillStyle = color;
		this.ctx.fillRect(x, y, this.laneWidth, height);
	},
	drawLongNote: function (startX, lane, startY, endY, color) {
		let x = startX + lane * this.laneWidth;
		let y = Math.min(startY, endY);
		let height = Math.abs(endY - startY);
		this.ctx.fillStyle = color;
		this.ctx.fillRect(x, y, this.laneWidth, height);
	},
	start: function (gameUpdate) {
		const loop = () => {
			this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
			gameUpdate();
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
	},
};
const LibraryManager = {
	dataBase: null,
	initDB: function (callback) {
		const request = indexedDB.open("osuManiaSongLibrary", 1);
		request.onupgradeneeded = function (e) {
			const dataBase = e.target.result;
			if (!dataBase.objectStoreNames.contains("songs")) {
				dataBase.createObjectStore("songs", { keyPath: "folderName" });
			}
		};
		request.onsuccess = (e) => {
			this.dataBase = e.target.result;
			if (callback) callback();
		};
	},
	processOsz: async function (file, callback) {
		try {
			console.log("starting extraction of: " + file.name);
			const zip = await JSZip.loadAsync(file);
			let songData = {
				folderName: file.name.replace(".osz", ""),
				maps: [],
				audioBlob: null,
			};
			let largestMp3Size = 0;
			for (let filename of Object.keys(zip.files)) {
				if (zip.files[filename].dir) continue;
				let cleanName = filename.toLowerCase();
				if (cleanName.endsWith(".osu")) {
					const text = await zip.files[filename].async("text");
					let shortName = filename.substring(
						filename.lastIndexOf("/") + 1,
					);
					songData.maps.push({ filename: shortName, content: text });
					console.log("extracted map data for diff: " + shortName);
				} else if (cleanName.endsWith(".mp3") || cleanName.endsWith(".ogg") || cleanName.endsWith(".wav")) {
					const uint8Array = await zip.files[filename].async("uint8Array");
					let fileSize = uint8Array.length;
					if (fileSize > largestMp3Size) {
						largestMp3Size = fileSize;
						let audioType = "audio/mp3";
						if (cleanName.endsWith(".ogg")) audioType = "audio/ogg";
						if (cleanName.endsWith(".wav")) audioType = "audio/wav";
						songData.audioBlob = new Blob([uint8Array], { type: audioType });
						console.log("isolate background music: " + filename + " (" + fileSize + " bytes)");
					} else {
						console.log("safely discarded hit-sound asset: " + filename + " (" + fileSize + " bytes)");
					}
				}
			}
			if (!songData.audioBlob || songData.maps.length === 0) {
				console.error(
					"import margin error: this package lacks a valid layout configuration",
				);
				alert("import failed: make sure this is a valid .osz map file");
				return;
			}
			const transaction = this.dataBase.transaction(
				["songs"],
				"readwrite",
			);
			const store = transaction.objectStore("songs");
			store.put(songData);
			transaction.oncomplete = () => {
				console.log("successfully save map to library cache");
				if (callback) callback();
			};
		} catch (error) {
			console.error("zip engine crash:", error);
		}
	},
	getAllSongs: function (callback) {
		const transaction = this.dataBase.transaction(["songs"], "readonly");
		const store = transaction.objectStore("songs");
		const request = store.getAll();
		request.onsuccess = function () {
			callback(request.result);
		};
	},
};
