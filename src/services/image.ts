const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function prepareJpeg(
  file: File,
  options: { maxInputBytes: number; maxDimension: number; maxOutputBytes: number },
): Promise<Blob> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP picture.");
  }
  if (file.size <= 0 || file.size > options.maxInputBytes) {
    throw new Error(`Choose a picture under ${Math.ceil(options.maxInputBytes / 1024 / 1024)} MB.`);
  }

  const source = await loadImage(file);
  let maxDimension = options.maxDimension;
  const qualities = [0.82, 0.72, 0.62, 0.5, 0.4];

  for (let sizeAttempt = 0; sizeAttempt < 6; sizeAttempt += 1) {
    const scale = Math.min(1, maxDimension / Math.max(source.naturalWidth, source.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize pictures.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size > 3 && blob.size <= options.maxOutputBytes) return blob;
    }
    maxDimension = Math.max(320, Math.floor(maxDimension * 0.78));
  }
  throw new Error("The compressed picture is still too large.");
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  const image = new window.Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The selected file is not a readable picture."));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("The picture has no dimensions.");
  return image;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("The picture could not be compressed."));
    }, "image/jpeg", quality);
  });
}
