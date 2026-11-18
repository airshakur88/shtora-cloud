// BENCHMARK: safe - Ktor SSRF destination validation
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.server.routing.*
import java.net.URI

private val allowedHosts = setOf("api.example.com")

fun Route.proxy(client: HttpClient) {
    get("/fetch") {
        val target = call.parameters["url"]!!
        val parsed = URI.create(target)
        if (parsed.scheme != "https" || !allowedHosts.contains(parsed.host)) return@get
        client.get(target)
    }
}
