(() => {
	const previewUrls = new WeakMap();
	const dialog = document.createElement("dialog");
	dialog.className = "image-crop-dialog";
	dialog.setAttribute("aria-labelledby", "image-crop-title");
	dialog.innerHTML = `
		<div class="image-crop-content">
			<div class="image-crop-heading">
				<h2 id="image-crop-title">Crop image</h2>
				<p>Drag the image to adjust it, then use the slider to zoom.</p>
			</div>
			<div class="image-crop-stage">
				<canvas aria-label="Image crop preview"></canvas>
			</div>
			<label class="image-crop-zoom">
				<span>Zoom</span>
				<input type="range" min="1" max="3" step="0.01" value="1">
			</label>
			<p class="image-crop-error" role="alert" hidden></p>
			<div class="image-crop-actions">
				<button class="image-crop-cancel" type="button">Cancel</button>
				<button class="image-crop-confirm" type="button">Use this image</button>
			</div>
		</div>`;
	document.body.append(dialog);

	const canvas = dialog.querySelector("canvas");
	const context = canvas.getContext("2d");
	const zoomInput = dialog.querySelector('input[type="range"]');
	const errorMessage = dialog.querySelector(".image-crop-error");
	const title = dialog.querySelector("#image-crop-title");
	let activeCrop = null;
	let dragging = false;
	let dragPoint = null;

	function releasePreview(input) {
		const previewUrl = previewUrls.get(input);
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrls.delete(input);
	}

	function getPreview(input) {
		let preview = input.nextElementSibling;
		if (!preview || !preview.classList.contains("upload-preview")) {
			preview = document.createElement("div");
			preview.className = "upload-preview";
			preview.hidden = true;
			input.after(preview);
		}
		return preview;
	}

	function showImagePreview(input, file, url) {
		const preview = getPreview(input);
		const image = document.createElement("img");
		const fileName = document.createElement("span");
		const label = input.labels && input.labels[0];
		const fieldName = (input.name || "").toLowerCase();
		const kind = fieldName.includes("profile") || fieldName.includes("logo")
			? "square"
			: fieldName.includes("cover") || fieldName.includes("photo")
				? "landscape"
				: "standard";

		image.className = `upload-preview-image upload-preview-image-${kind}`;
		image.src = url;
		image.alt = `${label ? label.textContent.trim() : "Selected image"} preview`;
		fileName.className = "upload-preview-name";
		fileName.textContent = file.name;
		preview.replaceChildren(image, fileName);
		preview.hidden = false;
	}

	function showResumePreview(input, file, url) {
		const preview = getPreview(input);
		const fileName = document.createElement("span");
		fileName.className = "upload-preview-name";
		fileName.textContent = file.name;
		preview.replaceChildren(fileName);

		if (file.type === "application/pdf") {
			const frame = document.createElement("iframe");
			frame.className = "upload-resume-frame";
			frame.src = url;
			frame.title = `Preview of ${file.name}`;
			preview.append(frame);
		} else {
			const note = document.createElement("span");
			note.className = "upload-preview-note";
			note.textContent = "File selected. Preview is available after downloading this document.";
			preview.append(note);
		}
		preview.hidden = false;
	}

	function clearPreview(input) {
		releasePreview(input);
		const preview = input.nextElementSibling;
		if (preview && preview.classList.contains("upload-preview")) {
			preview.replaceChildren();
			preview.hidden = true;
		}
	}

	function cropAspect(input) {
		const fieldName = (input.name || "").toLowerCase();
		if (fieldName.includes("cover")) return 3;
		if (fieldName.includes("photo")) return 16 / 9;
		return 1;
	}

	function renderCrop() {
		if (!activeCrop) return;
		const {image, aspect, zoom, offsetX, offsetY} = activeCrop;
		const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) * zoom;
		const width = image.naturalWidth * scale;
		const height = image.naturalHeight * scale;
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, offsetX, offsetY, width, height);
	}

	function clampCropOffset() {
		if (!activeCrop) return;
		const {image, zoom} = activeCrop;
		const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) * zoom;
		const width = image.naturalWidth * scale;
		const height = image.naturalHeight * scale;
		activeCrop.offsetX = Math.min(0, Math.max(canvas.width - width, activeCrop.offsetX));
		activeCrop.offsetY = Math.min(0, Math.max(canvas.height - height, activeCrop.offsetY));
	}

	function cleanupCrop() {
		if (!activeCrop) return;
		const {input, sourceUrl, committed} = activeCrop;
		URL.revokeObjectURL(sourceUrl);
		if (!committed) {
			input.value = "";
			clearPreview(input);
		}
		activeCrop = null;
	}

	dialog.addEventListener("close", cleanupCrop);
	dialog.addEventListener("cancel", () => {
		if (activeCrop) activeCrop.committed = false;
	});

	canvas.addEventListener("pointerdown", (event) => {
		if (!activeCrop) return;
		dragging = true;
		dragPoint = {x: event.clientX, y: event.clientY};
		canvas.setPointerCapture(event.pointerId);
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!dragging || !activeCrop) return;
		const bounds = canvas.getBoundingClientRect();
		activeCrop.offsetX += (event.clientX - dragPoint.x) * canvas.width / bounds.width;
		activeCrop.offsetY += (event.clientY - dragPoint.y) * canvas.height / bounds.height;
		dragPoint = {x: event.clientX, y: event.clientY};
		clampCropOffset();
		renderCrop();
	});
	canvas.addEventListener("pointerup", () => {
		dragging = false;
	});
	canvas.addEventListener("pointercancel", () => {
		dragging = false;
	});

	zoomInput.addEventListener("input", () => {
		if (!activeCrop) return;
		const previousZoom = activeCrop.zoom;
		activeCrop.zoom = Number(zoomInput.value);
		const ratio = activeCrop.zoom / previousZoom;
		activeCrop.offsetX = canvas.width / 2 - (canvas.width / 2 - activeCrop.offsetX) * ratio;
		activeCrop.offsetY = canvas.height / 2 - (canvas.height / 2 - activeCrop.offsetY) * ratio;
		clampCropOffset();
		renderCrop();
	});

	dialog.querySelector(".image-crop-cancel").addEventListener("click", () => dialog.close());
	dialog.querySelector(".image-crop-confirm").addEventListener("click", () => {
		if (!activeCrop) return;
		errorMessage.hidden = true;
		const {input, file} = activeCrop;
		const outputType = ["image/jpeg", "image/png", "image/webp"].includes(file.type)
			? file.type
			: "image/png";
		canvas.toBlob((blob) => {
			if (!blob) {
				errorMessage.textContent = "Could not crop this image. Please try another image.";
				errorMessage.hidden = false;
				return;
			}
			const extension = blob.type === "image/jpeg" ? "jpg"
				: blob.type === "image/webp" ? "webp" : "png";
			const originalBaseName = file.name.replace(/\.[^.]+$/, "");
			const croppedFile = new File(
				[blob],
				`${originalBaseName}.${extension}`,
				{type: blob.type, lastModified: Date.now()}
			);
			try {
				const transfer = new DataTransfer();
				transfer.items.add(croppedFile);
				input.files = transfer.files;
			} catch (error) {
				errorMessage.textContent = "Your browser could not prepare the cropped image. Please use a recent browser and try again.";
				errorMessage.hidden = false;
				return;
			}

			releasePreview(input);
			const previewUrl = URL.createObjectURL(croppedFile);
			previewUrls.set(input, previewUrl);
			showImagePreview(input, croppedFile, previewUrl);
			activeCrop.committed = true;
			dialog.close();
		}, outputType, 0.9);
	});

	function openCropper(input, file) {
		clearPreview(input);
		const sourceUrl = URL.createObjectURL(file);
		const image = new Image();
		image.addEventListener("load", () => {
			const aspect = cropAspect(input);
			const width = 900;
			canvas.width = width;
			canvas.height = Math.round(width / aspect);
			activeCrop = {
				input,
				file,
				image,
				aspect,
				sourceUrl,
				zoom: 1,
				offsetX: 0,
				offsetY: 0,
				committed: false
			};
			const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
			activeCrop.offsetX = (canvas.width - image.naturalWidth * scale) / 2;
			activeCrop.offsetY = (canvas.height - image.naturalHeight * scale) / 2;
			zoomInput.value = "1";
			errorMessage.hidden = true;
			title.textContent = `Crop ${input.labels?.[0]?.textContent.trim() || "image"}`;
			showImagePreview(input, file, sourceUrl);
			renderCrop();
			dialog.showModal();
		}, {once: true});
		image.addEventListener("error", () => {
			URL.revokeObjectURL(sourceUrl);
			input.value = "";
			const preview = getPreview(input);
			preview.textContent = "This image could not be opened. Please choose another image.";
			preview.hidden = false;
		}, {once: true});
		image.src = sourceUrl;
	}

	document.querySelectorAll('input[type="file"]').forEach((input) => {
		input.addEventListener("change", () => {
			const file = input.files && input.files[0];
			if (!file) return;
			clearPreview(input);
			const isImage = input.accept.includes("image/")
				|| /\.(jpe?g|png|webp)$/i.test(file.name);
			const previewUrl = URL.createObjectURL(file);
			previewUrls.set(input, previewUrl);

			if (isImage) {
				openCropper(input, file);
			} else if (/\.(pdf|docx?)$/i.test(file.name)) {
				showResumePreview(input, file, previewUrl);
			}
		});
	});
})();
