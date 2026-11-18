# BENCHMARK: vulnerable - Rails SSRF

Net::HTTP.get(URI(params[:url]))
