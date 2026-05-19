FROM python:3.11-slim

# OpenCV (used internally by ultralytics) requires these shared libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the default model so the container starts offline
ARG YOLO_MODEL=yolov8n.pt
RUN python3 -c "from ultralytics import YOLO; YOLO('${YOLO_MODEL}')"

COPY yolo/ ./yolo/

CMD ["python3", "yolo/runner.py"]
