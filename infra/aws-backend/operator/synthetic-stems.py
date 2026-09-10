"""Emit an in-memory, deterministic 16-bar test ZIP. No user audio is read."""

import io
import math
import struct
import sys
import wave
import zipfile

rate = 44100
archive = io.BytesIO()
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as stems:
    for name in ("Drums", "Bass"):
        samples = bytearray()
        for index in range(rate * 32):
            time = index / rate
            beat = time % 0.5
            if name == "Drums":
                kick = math.sin(2 * math.pi * (70 * beat - 25 * beat * beat)) * math.exp(-beat * 24)
                hat = math.sin(2 * math.pi * 6000 * time) * math.exp(-(time % 0.25) * 150)
                value = 0.5 * kick + 0.12 * hat
            else:
                value = 0.3 * math.sin(2 * math.pi * 110 * time) * math.exp(-beat * 5)
            samples.extend(struct.pack("<h", round(value * 32767)))
        wav = io.BytesIO()
        with wave.open(wav, "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(rate)
            stream.writeframes(samples)
        stems.writestr(f"{name}.wav", wav.getvalue())
sys.stdout.buffer.write(archive.getvalue())
