// BENCHMARK: vulnerable - Ktor SSRF
import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.server.routing.*

fun Route.proxy(client: HttpClient) {
    get("/fetch") {
        val target = call.request.queryParameters["url"]!!
        client.get(target)
    }
}
