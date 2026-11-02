(() => {
	const panel = document.getElementById("job-assistant-panel");
	const toggle = document.getElementById("job-assistant-toggle");
	const close = document.getElementById("job-assistant-close");
	const messages = document.getElementById("job-assistant-messages");
	const form = document.getElementById("job-assistant-form");
	const input = document.getElementById("job-assistant-input");
	const listingsElement = document.getElementById("job-assistant-listings");
	const assistant = document.querySelector(".job-assistant");

	if (!panel || !toggle || !close || !messages || !listingsElement || !assistant) return;

	let jobs = [];
	try {
		jobs = JSON.parse(listingsElement.textContent);
	} catch (error) {
		console.error("Could not read the job assistant listing data.", error);
	}

	function setOpen(isOpen) {
		panel.hidden = !isOpen;
		toggle.setAttribute("aria-expanded", String(isOpen));
		if (isOpen && input) input.focus();
		else if (!isOpen) toggle.focus();
	}

	function addMessage(text, sender) {
		const message = document.createElement("div");
		message.className = `assistant-message assistant-message-${sender}`;
		message.textContent = text;
		messages.append(message);
		messages.scrollTop = messages.scrollHeight;
		return message;
	}

	toggle.addEventListener("click", () => setOpen(panel.hidden));
	close.addEventListener("click", () => setOpen(false));

	if (!form || !input) return;

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const message = input.value.trim();
		if (!message) return;

		addMessage(message, "user");
		input.value = "";
		input.disabled = true;
		const submitButton = form.querySelector("button");
		submitButton.disabled = true;
		const loadingMessage = addMessage("Reviewing your request...", "bot");

		try {
			const response = await fetch(assistant.dataset.endpoint, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({
					message,
					jobs,
					csrf_token: assistant.dataset.csrfToken
				})
			});
			let result;
			try {
				result = await response.json();
			} catch {
				throw new Error("The server returned an unexpected response. Refresh the page and try again.");
			}
			if (!response.ok) throw new Error(result.error || "Could not contact the assistant.");

			loadingMessage.textContent = result.reply;
			for (const index of result.recommended_indices) {
				const job = jobs[index];
				const card = document.getElementById(`job-card-${index}`);
				if (!job || !card) continue;
				const link = document.createElement("a");
				link.className = "assistant-job-link";
				link.href = `#job-card-${index}`;
				link.textContent = `${job.title} — ${job.company}`;
				loadingMessage.append(document.createElement("br"), link);
			}
			messages.scrollTop = messages.scrollHeight;
		} catch (error) {
			loadingMessage.textContent = error.message || "The assistant could not answer right now.";
		} finally {
			input.disabled = false;
			submitButton.disabled = false;
			input.focus();
		}
	});
})();
