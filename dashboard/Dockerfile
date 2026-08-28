FROM registry.access.redhat.com/ubi9/python-311:latest

WORKDIR /opt/app-root/src

# Copy Python requirements and install dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy ALL application files and directories (server.py, ui/, static/, templates/)
COPY . ./

# Ensure correct permissions for OpenShift's default unprivileged user
USER root
RUN chown -R 1001:0 /opt/app-root/src && chmod -R g+rwX /opt/app-root/src
USER 1001

EXPOSE 5005

CMD ["python", "server.py"]