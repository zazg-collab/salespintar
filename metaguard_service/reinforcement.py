"""
metaguard_service/reinforcement.py

Resilient 8-Layer Video Presentation & Cloaking Reinforcement Engine (V7 Production Grade)
Ported from video-ad-hack-cloaker V7 with verified mathematical compliance.

Urutan 8-Layer Standar V7:
1. Layer 1: TEMPLATE_OVERLAY (Top Sleek Forest Green Banner + Periodic Dither Alpha)
2. Layer 2: ADVERSARIAL_NOISE (In-stream Laplacian micro-noise & high-frequency unsharp)
3. Layer 3: COLOR_GRADE (Earth & Nature Color LUT Saturation & Contrast Boost)
4. Layer 4: METADATA_LABEL (Polymorphic EXIF & Container Metadata with Runtime UUID Entropy)
5. Layer 5: TEMPORAL_JITTER (Micro-speed PTS, atempo, and dynamic FPS pHash disrupter)
6. Layer 6: HIGHLIGHT_SOFTEN (In-stream specular glare & highlight curve softener)
7. Layer 7: AUDIO_BEDDING (Psychoacoustic pink noise bedding at 2250Hz ASR frequency band)
8. Layer 8: MICRO_REFRAME (Calibrated 0.955x spatial crop & micro-zoom alignment anchor)

Semua operasi dieksekusi dalam 1-PASS FFmpeg pipeline untuk kecepatan render maksimal.
"""

from __future__ import annotations

import os
import re
import time
import uuid
import random
import hashlib
import tempfile
import subprocess
from enum import Enum
from pathlib import Path
from typing import List, Tuple, Any

import numpy as np
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw, ImageFont

from config import get_settings


class PresentationLayer(str, Enum):
    TEMPLATE_OVERLAY = "template_overlay"    # Layer 1 — Top Banner Glassmorphism & Alpha Dither
    ADVERSARIAL_NOISE = "adversarial_noise"  # Layer 2 — Adversarial Laplacian Micro-Noise & Unsharp
    COLOR_GRADE = "color_grade"              # Layer 3 — Earth & Nature Color-Grading Saturation Shift
    METADATA_LABEL = "metadata_label"        # Layer 4 — Polymorphic Binary Container & EXIF Metadata
    TEMPORAL_JITTER = "temporal_jitter"      # Layer 5 — Temporal Micro-Speed & pHash Disrupter
    HIGHLIGHT_SOFTEN = "highlight_soften"    # Layer 6 — Specular Glare & Highlight Curve Softener
    AUDIO_BEDDING = "audio_bedding"          # Layer 7 — Psychoacoustic Audio Bedding (2250Hz Pink Noise)
    MICRO_REFRAME = "micro_reframe"          # Layer 8 — Micro-Scale Geometry Anchor (0.955x Crop)


class PresentationReinforcementRequest(BaseModel):
    video_path: str
    layers: List[PresentationLayer] = Field(default_factory=list)


class PresentationReinforcementResult(BaseModel):
    job_id: str
    output_video_path: str
    layers_applied: List[PresentationLayer]
    processing_time_seconds: float


def _get_video_info(video_path: str) -> dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,duration",
        "-of", "json", video_path
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"Gagal membaca info video ffprobe: {res.stderr.strip()}")
    import json
    data = json.loads(res.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video or not video.get("width") or not video.get("height"):
        raise ValueError("Tidak ditemukan video stream yang valid.")
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    duration = data.get("format", {}).get("duration") or video.get("duration") or 0
    return {
        "width": int(video["width"]),
        "height": int(video["height"]),
        "duration": float(duration),
        "has_audio": audio is not None
    }


def _audio_is_effectively_silent(video_path: str, has_audio: bool) -> bool:
    if not has_audio:
        return True
    res = subprocess.run([
        "ffmpeg", "-hide_banner", "-nostdin", "-i", video_path, "-map", "0:a:0",
        "-vn", "-af", "volumedetect", "-f", "null", "-"
    ], capture_output=True, text=True, check=False)
    match = re.search(r"mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB", res.stderr)
    if not match:
        return True
    val = match.group(1)
    return val == "-inf" or float(val) <= -60.0


def _get_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            pass
    return ImageFont.load_default()


def _generate_banner_png(width: int, height: int, output_png_path: str, inject_dither: bool = True) -> None:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    top_h = max(24, int(height * 0.065))
    draw.rectangle([(0, 0), (width, top_h)], fill=(16, 42, 20, 205))
    draw.line([(0, top_h - 1), (width, top_h - 1)], fill=(60, 150, 75, 180), width=1)
    
    font_size = max(10, int(top_h * 0.28))
    font_main = _get_font(font_size)
    text_main = "AGRO SERIES  •  PERKAKAS PERKEBUNAN"
    bbox = draw.textbbox((0, 0), text_main, font=font_main)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (width - tw) // 2
    ty = (top_h - th) // 2
    draw.text((tx, ty), text_main, fill=(240, 248, 242, 235), font=font_main)

    if inject_dither:
        arr = np.array(img, dtype=np.uint8)
        y0, y1 = int(height * 0.16), int(height * 0.84)
        x0, x1 = int(width * 0.12), int(width * 0.88)
        y_coords, x_coords = np.ogrid[y0:y1, x0:x1]
        dither_x = np.sin(2 * np.pi * x_coords / 16.0).astype(np.float32)
        dither_y = np.cos(2 * np.pi * y_coords / 19.0).astype(np.float32)
        dither_combined = dither_x + dither_y
        dither_val = np.clip(128 + dither_combined * 24, 0, 255).astype(np.uint8)
        dither_alpha = np.clip(np.abs(dither_combined) * 8 + 6, 0, 18).astype(np.uint8)
        arr[y0:y1, x0:x1, 0] = dither_val
        arr[y0:y1, x0:x1, 1] = dither_val
        arr[y0:y1, x0:x1, 2] = dither_val
        arr[y0:y1, x0:x1, 3] = dither_alpha
        img = Image.fromarray(arr, mode="RGBA")
        
    img.save(output_png_path, "PNG")


def _generate_polymorphic_metadata(input_path: Path) -> dict[str, str]:
    run_entropy = uuid.uuid4().hex[:6].upper()
    batch_num = random.randint(100, 999)
    titles = [
        f"Katalog Alat Perkebunan & Perawatan Sawit - Batch #{run_entropy}",
        f"Dokumentasi Uji Ketahanan Perkakas Kebun Seri #{batch_num}",
        f"Spesifikasi Teknis Alat Pemotong Agrikultur Baja #{run_entropy}",
        f"Panduan Pemeliharaan & Penggunaan Perkakas Tani #{batch_num}"
    ]
    genres = [
        "Agriculture & Forestry Tools",
        "Agricultural Machinery & Equipment",
        "Farm & Garden Hand Tools",
        "Industrial Forestry Hardware"
    ]
    comments = [
        f"Pengujian bilah baja per tempaan standar industri pertanian #{run_entropy}",
        f"Dokumentasi kontrol kualitas perkakas kebun perorangan #{batch_num}",
        f"Arsip spesifikasi alat tebas dan potong perkebunan #{run_entropy}"
    ]
    seed = int(run_entropy, 16)
    return {
        "title": titles[seed % len(titles)],
        "genre": genres[(seed >> 2) % len(genres)],
        "comment": comments[(seed >> 4) % len(comments)],
        "copyright": f"Jawara Perkakas Agrikultur (Reg #{run_entropy})"
    }


def _execute_v7_reinforcement_pipeline(
    input_path: str,
    output_path: str,
    layers: List[PresentationLayer]
) -> None:
    input_file = Path(input_path).resolve()
    output_file = Path(output_path).resolve()
    info = _get_video_info(str(input_file))
    width, height = info["width"] - (info["width"] % 2), info["height"] - (info["height"] % 2)
    has_valid_audio = info["has_audio"] and not _audio_is_effectively_silent(str(input_file), True)
    
    seed = int(hashlib.md5((str(input_file.name) + str(input_file.stat().st_size)).encode()).hexdigest(), 16)
    
    if PresentationLayer.TEMPORAL_JITTER in layers:
        pts_jitter = round(0.988 + (seed % 9) * 0.001, 4)
        speed_factor = round(1.0 / pts_jitter, 4)
        fps_jitter = round(29.98 + (seed % 11) * 0.005, 4)
    else:
        pts_jitter = 1.0
        speed_factor = 1.0
        fps_jitter = 30.0

    ffmpeg_inputs = ["-i", str(input_file)]
    video_filters = []
    
    if PresentationLayer.TEMPORAL_JITTER in layers:
        video_filters.append(f"setpts={pts_jitter}*PTS,fps={fps_jitter}")
        
    if PresentationLayer.MICRO_REFRAME in layers:
        video_filters.append(f"crop=trunc(in_w*0.955/2)*2:trunc(in_h*0.955/2)*2:6:6,scale={width}:{height}")
        
    if PresentationLayer.COLOR_GRADE in layers:
        video_filters.append("eq=saturation=1.14:contrast=1.03:gamma_g=1.06")
        
    if PresentationLayer.ADVERSARIAL_NOISE in layers:
        video_filters.append("unsharp=5:5:1.6:5:5:0.0,noise=alls=6:allf=t+u")
        
    if PresentationLayer.HIGHLIGHT_SOFTEN in layers:
        video_filters.append("curves=all='0/0 0.85/0.82 0.95/0.89 1/0.94'")

    v_current = "0:v"
    filter_complex_parts = []
    
    if video_filters:
        filter_complex_parts.append(f"[{v_current}]{','.join(video_filters)}[v_base]")
        v_current = "v_base"

    input_idx = 1  # 0 is base video
    
    temp_dir = tempfile.TemporaryDirectory(prefix="sp_reinforce_")
    banner_path = str(Path(temp_dir.name) / "banner_v7.png")
    
    if PresentationLayer.TEMPLATE_OVERLAY in layers:
        inject_dither = (PresentationLayer.ADVERSARIAL_NOISE in layers)
        _generate_banner_png(width, height, banner_path, inject_dither=inject_dither)
        banner_idx = input_idx
        ffmpeg_inputs += ["-loop", "1", "-framerate", "30", "-i", banner_path]
        input_idx += 1
        filter_complex_parts.append(f"[{v_current}][{banner_idx}:v]overlay=0:0:format=auto:shortest=1[v_out]")
        v_final = "v_out"
    else:
        v_final = v_current

    use_audio_bedding = (PresentationLayer.AUDIO_BEDDING in layers)
    if use_audio_bedding:
        pink_idx = input_idx
        ffmpeg_inputs += ["-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=44100:amplitude=0.15"]
        input_idx += 1
        if has_valid_audio:
            filter_complex_parts.append(
                f"[0:a]atempo={speed_factor},volume=1.65,aformat=sample_rates=44100:channel_layouts=stereo[a_main];"
                f"[{pink_idx}:a]bandpass=f=2250:w=2500,volume=2.50,aformat=sample_rates=44100:channel_layouts=stereo[a_amb];"
                f"[a_main][a_amb]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[a_out]"
            )
            a_final = "a_out"
        else:
            filter_complex_parts.append(f"[{pink_idx}:a]bandpass=f=2250:w=2500,volume=1.50,apad[a_out]")
            a_final = "a_out"
    else:
        if has_valid_audio and PresentationLayer.TEMPORAL_JITTER in layers:
            filter_complex_parts.append(f"[0:a]atempo={speed_factor}[a_out]")
            a_final = "a_out"
        elif has_valid_audio:
            a_final = "0:a"
        else:
            a_final = None

    if PresentationLayer.METADATA_LABEL in layers:
        meta_dict = _generate_polymorphic_metadata(input_file)
    else:
        meta_dict = {
            "title": f"SalesPintar Video - {uuid.uuid4().hex[:6]}",
            "genre": "E-Commerce Media",
            "comment": "Optimized by MetaGuard AI",
            "copyright": "SalesPintar Ecosystem"
        }

    gop_size = 15 + (seed % 15)
    cmd = [get_settings().ffmpeg_bin, "-y", "-hide_banner", "-nostdin", *ffmpeg_inputs]
    
    if filter_complex_parts:
        cmd += ["-filter_complex", ";".join(filter_complex_parts)]
        cmd += ["-map", f"[{v_final}]"]
        if a_final:
            cmd += ["-map", f"[{a_final}]" if a_final != "0:a" else "0:a"]
    else:
        cmd += ["-map", "0:v"]
        if has_valid_audio:
            cmd += ["-map", "0:a"]

    cmd += [
        "-shortest",
        "-metadata", f"title={meta_dict['title']}",
        "-metadata", f"genre={meta_dict['genre']}",
        "-metadata", f"comment={meta_dict['comment']}",
        "-metadata", f"copyright={meta_dict['copyright']}",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-g", str(gop_size),
        "-maxrate", "8M", "-bufsize", "16M",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_file)
    ]
    
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if res.returncode != 0:
            raise RuntimeError(f"FFmpeg Error:\n{res.stderr.strip()}")
    finally:
        temp_dir.cleanup()


async def reinforce_presentation(req: PresentationReinforcementRequest) -> PresentationReinforcementResult:
    t0 = time.time()
    input_file = Path(req.video_path)
    output_path = str(input_file.with_name(f"{input_file.stem}_v7_cloaked.mp4"))
    active_layers = req.layers if req.layers else list(PresentationLayer)
    
    _execute_v7_reinforcement_pipeline(
        input_path=req.video_path,
        output_path=output_path,
        layers=active_layers
    )
    
    return PresentationReinforcementResult(
        job_id=f"pr_{os.urandom(6).hex()}",
        output_video_path=output_path,
        layers_applied=active_layers,
        processing_time_seconds=round(time.time() - t0, 2),
    )

