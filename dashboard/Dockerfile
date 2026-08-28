FROM registry.access.redhat.com/ubi9/python-311:latest
WORKDIR /opt/app-root/src

# Install dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy server.py into the root of the app
COPY server.py ./

# Create the ui directory and copy assets into it
RUN mkdir ui
COPY index.html ./ui/
COPY app.js ./ui/

# Expose the correct port
EXPOSE 5005

# Run the Flask server
CMD ["python", "server.py"]