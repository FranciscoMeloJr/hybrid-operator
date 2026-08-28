FROM registry.access.redhat.com/ubi9/python-311:latest
WORKDIR /opt/app-root/src

# Copy Python requirements and install dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy server script
COPY server.py ./

# Create ui directory and copy assets into it (matches server.py expectations)
RUN mkdir -p ui
COPY index.html ./ui/
COPY app.js ./ui/

EXPOSE 5005

CMD ["python", "server.py"]