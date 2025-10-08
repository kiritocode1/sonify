"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";

type OscType = "sine" | "square" | "triangle" | "sawtooth";
type ScaleName = "Major" | "Minor" | "Pentatonic" | "Blues" | "Chromatic" | "WholeTone";

export default function Page() {
	return (
		<main className="min-h-dvh w-full bg-black text-white">
			<SonificationDemo />
		</main>
	);
}

function SonificationDemo() {
	// Canvas refs
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);

	// Image state
	const [selectedDemo, setSelectedDemo] = useState<string>("demo1");
	const [imageSrc, setImageSrc] = useState<string>("/abstract-color-blocks.jpg");
	const originalImageRef = useRef<HTMLImageElement | null>(null);
	const imgWidthRef = useRef<number>(0);
	const imgHeightRef = useRef<number>(0);
	const imageDataRef = useRef<Uint8ClampedArray | null>(null);

	// Playback / audio
	const [playing, setPlaying] = useState(false);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const masterGainRef = useRef<GainNode | null>(null);
	const bassShelfRef = useRef<BiquadFilterNode | null>(null);
	const convolverRef = useRef<ConvolverNode | null>(null);
	const timeoutsRef = useRef<number[]>([]);
	const oscillatorsRef = useRef<OscillatorNode[]>([]);
	const [autoplayBlocked, setAutoplayBlocked] = useState(false);

	// Controls
	const [volume, setVolume] = useState(0.9); // 0..1
	const [bpm, setBpm] = useState(160); // affects derived note duration if used
	const [speed, setSpeed] = useState(0.5); // multiplier to derive note duration from BPM
	const [noteDuration, setNoteDuration] = useState(0.25); // explicit note duration (s)
	const [pixelStep, setPixelStep] = useState(1); // step in pixels
	const [oscType, setOscType] = useState<OscType>("sawtooth");
	const [scale, setScale] = useState<ScaleName>("Major");

	// Progress state for minimalist progress bar
	const [progress, setProgress] = useState(0);

	// Drawer open state
	const [drawerOpen, setDrawerOpen] = useState(false);

	// Constants
	const MAX_PLAYABLE_SIZE = 24; // downsample target (max dimension)
	const MAX_NOTE_DURATION = 2.0;

	const effectiveNoteDuration = useMemo(() => {
		const derived = Math.min((60 / bpm) * speed, MAX_NOTE_DURATION);
		// Let the explicit noteDuration take precedence if user prefers direct control
		return Math.min(Math.max(noteDuration, 0.05), MAX_NOTE_DURATION) || derived;
	}, [bpm, speed, noteDuration]);

	const scales = useMemo(
		() => ({
			Major: [261.63, 293.66, 329.63, 392.0, 440.0, 523.25], // C D E G A C
			Minor: [261.63, 293.66, 311.13, 392.0, 415.3, 523.25], // C D D# G G# C
			Pentatonic: [261.63, 293.66, 349.23, 392.0, 466.16, 523.25], // C D F G A# C
			Blues: [261.63, 293.66, 311.13, 349.23, 392.0, 466.16, 523.25], // C D D# F G A# C
			Chromatic: [261.63, 277.18, 293.66, 311.13, 329.63, 349.23, 369.99, 392.0, 415.3, 440.0, 466.16, 493.88, 523.25],
			WholeTone: [261.63, 293.66, 329.63, 369.99, 415.3, 466.16, 523.25],
		}),
		[],
	);

	const demoImages = useMemo(
		() => [
			{ id: "demo1", label: "Abstract Blocks", url: "/abstract-color-blocks.jpg" },
			{ id: "demo2", label: "City Lights", url: "/city-lights-bokeh.jpg" },
			{ id: "demo3", label: "Gradient Waves", url: "/gradient-waves.png" },
			{ id: "demo4", label: "Vivid Landscape", url: "/vivid-landscape.jpg" },
			{ id: "demo5", label: "Pop Art", url: "/pop-art-color.jpg" },
			{ id: "demo6", label: "Colorful Portrait", url: "/colorful-abstract-portrait.png" },
		],
		[],
	);

	// Utility: clamp and perceptual volume
	const perceptualVolume = useCallback((v: number) => Math.pow(Math.min(Math.max(v, 0), 1), 2), []);

	// HSL conversion
	const rgbToHsl = useCallback((r: number, g: number, b: number) => {
		r /= 255;
		g /= 255;
		b /= 255;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const d = max - min;
		let h = 0;
		if (d !== 0) {
			if (max === r) h = ((g - b) / d) % 6;
			else if (max === g) h = (b - r) / d + 2;
			else h = (r - g) / d + 4;
			h *= 60;
			if (h < 0) h += 360;
		}
		const l = (max + min) / 2;
		const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
		return [Number.parseFloat(h.toFixed(2)), Number.parseFloat((s * 100).toFixed(2)), Number.parseFloat((l * 100).toFixed(2))] as const;
	}, []);

	// Hue -> frequency with scale + octave via lightness + slight detune + optional harmonic
	const hueToFreq = useCallback(
		(hue: number, lightness: number) => {
			const sc = scales[scale] || scales.Major;
			const noteIndex = Math.floor(Math.sqrt(hue / 360) * sc.length) % sc.length;
			let base = sc[noteIndex] ?? 261.63;
			const octaveShift = Math.floor((lightness / 100) * 3) - 1; // -1..+2
			base *= Math.pow(2, octaveShift);
			if (!isFinite(base) || base <= 0) base = 261.63;
			base += (Math.random() - 0.5) * 5; // subtle detune

			// 50% chance to add harmonic: 5th or octave
			const addHarm = Math.random() > 0.5 ? (Math.random() > 0.5 ? 1.5 : 2) : 1;
			return { freq: base, harmonicMult: addHarm };
		},
		[scale, scales],
	);

	// Initialize / ensure audio graph
	const ensureAudio = useCallback(async () => {
		if (!audioCtxRef.current) {
			audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
		}
		const ctx = audioCtxRef.current!;
		if (!masterGainRef.current) {
			masterGainRef.current = ctx.createGain();
			masterGainRef.current.gain.value = perceptualVolume(volume);
			// Bass shelf
			bassShelfRef.current = ctx.createBiquadFilter();
			bassShelfRef.current.type = "lowshelf";
			bassShelfRef.current.frequency.value = 200;
			bassShelfRef.current.gain.value = 6;

			// Simple reverb via Convolver
			convolverRef.current = ctx.createConvolver();
			convolverRef.current.buffer = createReverbImpulse(ctx, 1.8, 2.5);

			// Routing: dry -> master, wet -> master
			const dryGain = ctx.createGain();
			dryGain.gain.value = 0.85;
			const wetGain = ctx.createGain();
			wetGain.gain.value = 0.35;

			dryGain.connect(bassShelfRef.current);
			bassShelfRef.current!.connect(masterGainRef.current);
			convolverRef.current.connect(masterGainRef.current);
			masterGainRef.current.connect(ctx.destination);

			// Store on node for ease of access
			(masterGainRef.current as any).__dryGain = dryGain;
			(masterGainRef.current as any).__wetGain = wetGain;
		}
		// Update volume in case it changed
		masterGainRef.current!.gain.setTargetAtTime(perceptualVolume(volume), ctx.currentTime, 0.02);
		return ctx;
	}, [volume, perceptualVolume]);

	// Create an impulse response for reverb
	function createReverbImpulse(ctx: AudioContext, seconds = 2.0, decay = 2.0) {
		const rate = ctx.sampleRate;
		const length = rate * seconds;
		const impulse = ctx.createBuffer(2, length, rate);
		for (let ch = 0; ch < 2; ch++) {
			const channelData = impulse.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
			}
		}
		return impulse;
	}

	// Load image and prepare canvases
	const loadImage = useCallback((src: string) => {
		// Stop any playback and clear timers
		stopPlayback();
		setProgress(0);

		const img = new Image();
		img.crossOrigin = "anonymous";
		img.src = src;
		img.onload = () => {
			originalImageRef.current = img;

			const displayCanvas = canvasRef.current!;
			const ctx = displayCanvas.getContext("2d")!;
			displayCanvas.width = img.width;
			displayCanvas.height = img.height;
			ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
			ctx.drawImage(img, 0, 0, displayCanvas.width, displayCanvas.height);

			const temp = tempCanvasRef.current!;
			const tctx = temp.getContext("2d")!;
			const scaleFactor = Math.min(MAX_PLAYABLE_SIZE / img.width, MAX_PLAYABLE_SIZE / img.height, 1);
			const w = Math.max(1, Math.round(img.width * scaleFactor));
			const h = Math.max(1, Math.round(img.height * scaleFactor));
			imgWidthRef.current = w;
			imgHeightRef.current = h;

			temp.width = w;
			temp.height = h;
			tctx.clearRect(0, 0, w, h);
			tctx.drawImage(img, 0, 0, w, h);
			const data = tctx.getImageData(0, 0, w, h).data;
			imageDataRef.current = data;
		};
		img.onerror = () => {
			console.error("Failed to load image:", src);
		};
	}, []);

	// Process the image, pixel by pixel
	const playImage = useCallback(async () => {
		const displayCanvas = canvasRef.current;
		const tempData = imageDataRef.current;
		const img = originalImageRef.current;
		if (!displayCanvas || !tempData || !img) return;

		const ctx = await ensureAudio();
		if (ctx.state === "suspended") {
			try {
				await ctx.resume();
			} catch {
				setAutoplayBlocked(true);
				return;
			}
		}

		// Start
		setPlaying(true);

		const dctx = displayCanvas.getContext("2d")!;
		dctx.drawImage(img, 0, 0, displayCanvas.width, displayCanvas.height);

		const w = imgWidthRef.current;
		const h = imgHeightRef.current;

		const totalSteps = Math.ceil(w / Math.max(1, pixelStep)) * h;
		let processed = 0;
		setProgress(0);

		let x = 0;
		let y = 0;

		const stepOne = () => {
			if (!playingRef.current) return;
			if (y >= h) {
				setProgress(1);
				stopPlayback();
				return;
			}
			const index = (y * w + x) * 4;
			if (index >= tempData.length) {
				setProgress(1);
				stopPlayback();
				return;
			}
			const r = tempData[index] || 0;
			const g = tempData[index + 1] || 0;
			const b = tempData[index + 2] || 0;
			const [, , a] = [r, g, b, tempData[index + 3] || 255]; // alpha unused here

			const [hue, _sat, light] = rgbToHsl(r, g, b);
			const { freq, harmonicMult } = hueToFreq(hue, light);

			// Slight random offset for naturalness
			const randomOffset = (Math.random() - 0.5) * 0.2;
			scheduleNote(ctx, freq + randomOffset, light, harmonicMult);

			// Draw current pixel tile highlight
			dctx.fillStyle = `rgba(${r}, ${g}, ${b}, 1)`;
			dctx.fillRect(Math.floor((x / w) * displayCanvas.width), Math.floor((y / h) * displayCanvas.height), Math.ceil(displayCanvas.width / w), Math.ceil(displayCanvas.height / h));
			dctx.strokeStyle = "#f6f2f0";
			dctx.lineWidth = 2;
			dctx.strokeRect(Math.floor((x / w) * displayCanvas.width), Math.floor((y / h) * displayCanvas.height), Math.ceil(displayCanvas.width / w), Math.ceil(displayCanvas.height / h));

			// Advance
			x += Math.max(1, pixelStep);
			if (x >= w) {
				x = 0;
				y++;
			}

			processed += 1;
			if (totalSteps > 0) setProgress(Math.min(1, processed / totalSteps));

			// Schedule next pixel
			const t = window.setTimeout(stepOne, effectiveNoteDuration * 1000);
			timeoutsRef.current.push(t);
		};

		stepOne();
	}, [ensureAudio, effectiveNoteDuration, hueToFreq, pixelStep, rgbToHsl]);

	// Keep a stable ref for playing state
	const playingRef = useRef<boolean>(false);
	useEffect(() => {
		playingRef.current = playing;
	}, [playing]);

	function scheduleNote(ctx: AudioContext, baseFreq: number, lightness: number, harmonicMult: number) {
		const master = masterGainRef.current!;
		const dryGain: GainNode = (master as any).__dryGain;
		const wetGain: GainNode = (master as any).__wetGain;

		// Source oscillator
		const osc = ctx.createOscillator();
		osc.type = oscType;
		const gain = ctx.createGain();

		// Lowpass filter: brighter pixels allow more highs
		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.setValueAtTime(800 + lightness * 50, ctx.currentTime);

		// Vibrato
		const vibratoOsc = ctx.createOscillator();
		const vibratoGain = ctx.createGain();
		vibratoOsc.frequency.setValueAtTime(3 + lightness / 60, ctx.currentTime);
		vibratoGain.gain.setValueAtTime(Math.max(0.1, lightness / 100), ctx.currentTime);
		vibratoOsc.connect(vibratoGain).connect(osc.frequency);

		// Tremolo
		const tremoloOsc = ctx.createOscillator();
		const tremoloGain = ctx.createGain();
		tremoloOsc.frequency.setValueAtTime(3 + lightness / 50, ctx.currentTime);
		tremoloGain.gain.setValueAtTime(Math.max(0.1, lightness / 250), ctx.currentTime);
		tremoloOsc.connect(tremoloGain).connect(gain.gain);

		// Harmonic layering (soft)
		const harmonic = ctx.createOscillator();
		harmonic.type = oscType;
		const harmonicGain = ctx.createGain();
		harmonicGain.gain.value = 0.25; // subtle
		harmonic.frequency.value = baseFreq * harmonicMult;

		// Pixel volume scaling so all pixels contribute
		const minGain = 0.3;
		const pixelVolume = Math.max(minGain, 0.6 + lightness / 100);

		// Routing: source -> filter -> gain -> (dry/wet)
		osc.connect(filter);
		filter.connect(gain);
		gain.connect((master as any).__dryGain);
		gain.connect(wetGain);

		// Harmonic routing
		harmonic.connect(filter);

		// Wet through reverb convolver
		wetGain.disconnect();
		wetGain.connect(convolverRef.current!);

		// Envelope
		const now = ctx.currentTime;
		const dur = effectiveNoteDuration;
		const userVol = perceptualVolume(volume);

		// Set base frequencies
		osc.frequency.setValueAtTime(baseFreq, now);

		// Master gain already set to perceptual volume, we shape per-note envelope on the note gain
		gain.gain.cancelScheduledValues(now);
		gain.gain.setValueAtTime(0.0, now);
		gain.gain.linearRampToValueAtTime(pixelVolume * userVol, now + 0.02);
		gain.gain.linearRampToValueAtTime(pixelVolume * userVol * 0.8, now + dur * 0.5);
		gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

		// Start/stop
		osc.start(now);
		vibratoOsc.start(now);
		tremoloOsc.start(now);
		harmonic.start(now);

		const stopAt = now + dur + 0.1;
		osc.stop(stopAt);
		vibratoOsc.stop(stopAt);
		tremoloOsc.stop(stopAt);
		harmonic.stop(stopAt);

		oscillatorsRef.current.push(osc);
	}

	// Stop/Reset
	const stopPlayback = useCallback(() => {
		setPlaying(false);
		setProgress(0);
		// clear timers
		timeoutsRef.current.forEach((t) => window.clearTimeout(t));
		timeoutsRef.current = [];
		// stop oscillators
		oscillatorsRef.current.forEach((o) => {
			try {
				o.stop();
			} catch {}
		});
		oscillatorsRef.current = [];
		// redraw original image if present
		const c = canvasRef.current;
		const img = originalImageRef.current;
		if (c && img) {
			const dctx = c.getContext("2d")!;
			dctx.clearRect(0, 0, c.width, c.height);
			dctx.drawImage(img, 0, 0, c.width, c.height);
		}
	}, []);

	// Initialize canvases once
	useEffect(() => {
		if (!tempCanvasRef.current) tempCanvasRef.current = document.createElement("canvas");
	}, []);

	// Keep master volume in sync
	useEffect(() => {
		if (masterGainRef.current && audioCtxRef.current) {
			masterGainRef.current.gain.setTargetAtTime(perceptualVolume(volume), audioCtxRef.current.currentTime, 0.02);
		}
	}, [volume, perceptualVolume]);

	// Load default image on mount
	useEffect(() => {
		loadImage(imageSrc);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Autoplay unblock UI handler
	const handleUnblock = async () => {
		const ctx = await ensureAudio();
		try {
			await ctx.resume();
		} catch (e) {
			console.warn("AudioContext resume blocked:", e);
		}
		setAutoplayBlocked(false);
		// If user intended to play, start now
		if (!playingRef.current) {
			setPlaying(true);
			playImage();
		}
	};

	// Handlers
	const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		if (!f) return;
		const url = URL.createObjectURL(f);
		setSelectedDemo("custom");
		setImageSrc(url);
		loadImage(url);
	};

	const onChangeDemo = (id: string) => {
		const found = demoImages.find((d) => d.id === id);
		if (!found) return;
		setSelectedDemo(id);
		setImageSrc(found.url);
		loadImage(found.url);
	};

	const onPlayToggle = async () => {
		if (playing) {
			stopPlayback();
			return;
		}
		const ctx = await ensureAudio();
		if (ctx.state === "suspended") {
			try {
				await ctx.resume();
			} catch {
				setAutoplayBlocked(true);
				return;
			}
		}
		setPlaying(true);
		playImage();
	};

	// Simple styles scoped to this component
	const styles: React.CSSProperties = {
		maxWidth: "min(96vw, 1024px)",
		width: "100%",
	};

	return (
		<section
			style={styles}
			className="mx-auto grid gap-8 bg-black text-white px-6 py-8"
		>
			<motion.header
				className="space-y-4"
				initial={{ opacity: 0, y: 8 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.35, ease: "easeOut" }}
			>
				<div className="flex items-center justify-between">
					<motion.button
						aria-label="Open settings"
						onClick={() => setDrawerOpen(true)}
						className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-2 text-xs tracking-widest uppercase bg-black"
						whileHover={{ scale: 1.02 }}
						whileTap={{ scale: 0.98 }}
					>
						Settings
					</motion.button>

					<motion.button
						whileHover={{ scale: 1.02 }}
						whileTap={{ scale: 0.98 }}
						className="inline-flex items-center justify-center rounded-md border border-white/20 px-4 py-2 text-xs tracking-widest uppercase bg-black"
						onClick={onPlayToggle}
					>
						<span>{playing ? "Stop" : "Play"}</span>
					</motion.button>
				</div>

				<div className="pt-2">
					<h1 className="text-[9vw] leading-none font-semibold tracking-tight uppercase">Sonification</h1>
					<div className="border-t border-white/15 mt-3 pt-3">
						<p className="text-sm text-neutral-400 tracking-wide">Map pixels to notes with vibrato, tremolo, harmonics, filtering, reverb, and bass boost.</p>
					</div>
				</div>
			</motion.header>

			<div className="grid gap-4">
				<motion.canvas
					id="output"
					ref={canvasRef}
					className="w-full h-auto rounded-none border border-white/15 bg-black "
					aria-label="Sonification output canvas"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.3 }}
				/>
				<div className="h-1 w-full bg-white/10 overflow-hidden">
					<motion.div
						className="h-full bg-white"
						initial={{ width: 0 }}
						animate={{ width: `${Math.round(progress * 100)}%` }}
						transition={{ type: "spring", stiffness: 120, damping: 20 }}
					/>
				</div>
			</div>

			<footer className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-neutral-400 border-t border-white/10 pt-3">
				<div className="flex items-center gap-3">
					<a
						href="https://aryank.space/"
						target="_blank"
						rel="noreferrer"
						className="hover:text-white transition-colors"
					>
						Built by Aryank — aryank.space
					</a>
				</div>
				<div className="flex items-center gap-3">
					<a
						href="https://www.lessrain.com"
						target="_blank"
						rel="noreferrer"
						className="hover:text-white transition-colors"
					>
						Inspiration: Less Rain GmbH
					</a>
				</div>
			</footer>

			<AnimatePresence>
				{drawerOpen && (
					<>
						<motion.div
							className="fixed inset-0 z-40 bg-black/60"
							role="button"
							aria-label="Close settings"
							tabIndex={-1}
							onClick={() => setDrawerOpen(false)}
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
						/>
						<motion.aside
							role="complementary"
							aria-label="Settings"
							className="fixed left-0 top-0 bottom-0 z-50 w-[360px] max-w-[88vw] bg-black text-white border-r border-white/15 p-5 overflow-y-auto"
							initial={{ x: -380, opacity: 0.8 }}
							animate={{ x: 0, opacity: 1 }}
							exit={{ x: -380, opacity: 0.8 }}
							transition={{ type: "spring", stiffness: 260, damping: 26 }}
						>
							<div className="flex items-center justify-between mb-4">
								<h2 className="text-xs tracking-widest uppercase text-neutral-400">Settings</h2>
								<motion.button
									onClick={() => setDrawerOpen(false)}
									className="rounded-none border border-white/20 px-2 py-1 text-[10px] tracking-widest uppercase bg-black"
									whileHover={{ scale: 1.05 }}
									whileTap={{ scale: 0.98 }}
								>
									Close
								</motion.button>
							</div>

							{/* Playback */}
							<fieldset className="grid gap-4 mb-6">
								<legend className="text-xs tracking-widest uppercase text-neutral-300">Playback</legend>
								<div className="flex items-end gap-6 overflow-x-auto pb-1 pr-2 -mr-2">
									{/* Eq-style sliders kept, just monochrome styling */}
									<EqSlider
										label="VOL"
										value={volume}
										min={0}
										max={1}
										step={0.01}
										onChange={setVolume}
										format={(v) => v.toFixed(2)}
										ariaLabel="Volume"
									/>
									<EqSlider
										label="BPM"
										value={bpm}
										min={40}
										max={240}
										step={1}
										onChange={(v) => setBpm(Math.round(v))}
										format={(v) => String(Math.round(v))}
										ariaLabel="BPM"
									/>
									<EqSlider
										label="SPD"
										value={speed}
										min={0.1}
										max={2}
										step={0.05}
										onChange={setSpeed}
										format={(v) => v.toFixed(2)}
										ariaLabel="Speed"
									/>
									<EqSlider
										label="DUR"
										value={noteDuration}
										min={0.05}
										max={2}
										step={0.01}
										onChange={(v) => setNoteDuration(v)}
										format={(v) => `${v.toFixed(2)}s`}
										ariaLabel="Note Duration"
									/>
									<EqSlider
										label="STEP"
										value={pixelStep}
										min={1}
										max={4}
										step={1}
										onChange={(v) => setPixelStep(Math.round(v))}
										format={(v) => String(Math.round(v))}
										ariaLabel="Pixel Step"
									/>
								</div>

								<div className="grid grid-cols-2 gap-3">
									<label className="grid gap-1">
										<span className="text-[11px] tracking-widest uppercase text-neutral-400">Oscillator</span>
										<select
											aria-label="Oscillator Type"
											value={oscType}
											onChange={(e) => setOscType(e.target.value as OscType)}
											className="min-h-8 rounded-none border border-white/20 px-2 py-1 text-sm bg-black"
										>
											<option value="sine">Sine</option>
											<option value="square">Square</option>
											<option value="sawtooth">Sawtooth</option>
											<option value="triangle">Triangle</option>
										</select>
									</label>

									<label className="grid gap-1">
										<span className="text-[11px] tracking-widest uppercase text-neutral-400">Scale</span>
										<select
											aria-label="Scale"
											value={scale}
											onChange={(e) => setScale(e.target.value as ScaleName)}
											className="min-h-8 rounded-none border border-white/20 px-2 py-1 text-sm bg-black"
										>
											<option value="Major">Major</option>
											<option value="Minor">Minor</option>
											<option value="Pentatonic">Pentatonic</option>
											<option value="Blues">Blues</option>
											<option value="Chromatic">Chromatic</option>
											<option value="WholeTone">Whole Tone</option>
										</select>
									</label>
								</div>
							</fieldset>

							{/* Image */}
							<fieldset className="grid gap-4">
								<legend className="text-xs tracking-widest uppercase text-neutral-300">Image</legend>

								<label className="grid gap-1">
									<span className="text-[11px] tracking-widest uppercase text-neutral-400">Select demo image</span>
									<motion.select
										aria-label="Demo Images"
										value={selectedDemo}
										onChange={(e) => onChangeDemo(e.target.value)}
										className="min-h-8 rounded-none border border-white/20 px-2 py-1 text-sm bg-black"
										whileHover={{ scale: 1.02 }}
									>
										{demoImages.map((d) => (
											<option
												key={d.id}
												value={d.id}
											>
												{d.label}
											</option>
										))}
										<option value="custom">Custom Upload</option>
									</motion.select>
								</label>

								<label className="grid gap-1">
									<span className="text-[11px] tracking-widest uppercase text-neutral-400">Upload image (png, jpg, webp)</span>
									<motion.input
										aria-label="Upload image"
										type="file"
										accept="image/png,image/jpeg,image/webp"
										onChange={onFileChange}
										className="text-sm"
										whileHover={{ scale: 1.02 }}
									/>
								</label>

								<p className="text-[11px] text-neutral-500">L→R, T→B; hue→scale; lightness→octave; vibrato, tremolo, harmonics, low‑pass, reverb, bass boost.</p>
							</fieldset>
						</motion.aside>
					</>
				)}
			</AnimatePresence>

			{/* Autoplay overlay */}
			{autoplayBlocked && (
				<motion.div
					role="dialog"
					aria-modal="true"
					className="fixed inset-0 z-50 grid place-items-center p-4"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
				>
					<div className="absolute inset-0 bg-black/85" />
					<motion.div
						className="relative z-10 rounded-none border border-white/20 bg-black text-white p-5 max-w-sm w-full text-center"
						initial={{ scale: 0.95, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.98, opacity: 0 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
					>
						<p className="text-sm mb-3 text-neutral-300">Autoplay was blocked by your browser. Click OK to start audio.</p>
						<motion.button
							whileHover={{ scale: 1.02 }}
							whileTap={{ scale: 0.98 }}
							className="inline-flex items-center justify-center rounded-none border border-white/20 px-4 py-2 text-xs tracking-widest uppercase bg-black"
							onClick={handleUnblock}
						>
							<span>OK</span>
						</motion.button>
					</motion.div>
				</motion.div>
			)}
		</section>
	);
}

// Reusable EqSlider component
function EqSlider({
	label,
	value,
	min,
	max,
	step = 1,
	onChange,
	format = (v: number) => v.toString(),
	ariaLabel,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (v: number) => void;
	format?: (v: number) => string;
	ariaLabel?: string;
}) {
	return (
		<div className="flex flex-col items-center gap-2">
			<div className="text-[10px] text-neutral-400 h-4">{format(value)}</div>
			<Slider
				value={[value]}
				min={min}
				max={max}
				step={step}
				orientation="vertical"
				onValueChange={(v) => onChange(v[0] ?? value)}
				aria-label={ariaLabel || label}
				className="[&>:last-child>span]:h-6 [&>:last-child>span]:w-4 [&>:last-child>span]:rounded [&>span]:bg-white/15"
				showTooltip
			/>
			<Label className="flex w-0 justify-center text-[10px] text-neutral-500">{label}</Label>
		</div>
	);
}
